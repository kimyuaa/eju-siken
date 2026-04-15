import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Repo root (parent of /server) — static HTML/CSS/JS live here */
const publicDir = path.resolve(__dirname, "..");

// Always load /server/.env regardless of process cwd.
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Simple in-memory cache to reduce repeated Gemini calls (429 mitigation).
// Keyed by request (context+seed+locale). TTL is short to keep memory bounded.
const reportCache = new Map(); // key -> { ts, payload }
function getCachedReport(key, ttlMs = 10 * 60_000) {
  const hit = reportCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttlMs) {
    reportCache.delete(key);
    return null;
  }
  return hit.payload || null;
}
function setCachedReport(key, payload) {
  // crude size bound: keep last ~40 items
  try {
    if (reportCache.size > 40) {
      const firstKey = reportCache.keys().next().value;
      if (firstKey) reportCache.delete(firstKey);
    }
  } catch {
    // ignore
  }
  reportCache.set(key, { ts: Date.now(), payload });
}

function withTimeout(promise, ms, label = "timeout") {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label}: ${t}ms`)), t);
    }),
  ]);
}

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function shaSeed(input) {
  const h = crypto.createHash("sha256").update(String(input)).digest("hex");
  // 32-bit
  return parseInt(h.slice(0, 8), 16) >>> 0;
}

async function googleCseSearch({ apiKey, cx, q, num = 5 }) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("num", String(Math.max(1, Math.min(10, num))));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  const res = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`CSE error: ${res.status} ${res.statusText} ${txt}`);
  }
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  return items.map((it) => ({
    title: it.title || "",
    url: it.link || "",
    snippet: it.snippet || ""
  }));
}

function isPlaceholderEnv(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  return s.startsWith("your_") || s.includes("your google") || s.includes("your_gemini") || s.includes("here");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/translate
 * Body: { text: string, locale?: "ko" }
 * Returns: { html: string }
 */
app.post("/api/translate", async (req, res) => {
  try {
    const locale = (req.body?.locale || "ko").toString();
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Missing text" });
    if (locale !== "ko") return res.status(400).json({ error: "Only ko is supported" });

    const fallbackMyMemory = async () => {
      const email = String(process.env.MYMEMORY_EMAIL || "").trim();

      const translateChunk = async (chunk) => {
        const url = new URL("https://api.mymemory.translated.net/get");
        url.searchParams.set("q", chunk);
        url.searchParams.set("langpair", "ja|ko");
        if (email) url.searchParams.set("de", email);

        const r = await fetch(url, { method: "GET" });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`MyMemory error: ${r.status} ${r.statusText} ${t}`);
        }
        const j = await r.json().catch(() => null);
        const tr = String(j?.responseData?.translatedText || "").trim();
        if (!tr) throw new Error("MyMemory empty translation");
        if (tr.includes("QUERY LENGTH LIMIT EXCEEDED")) throw new Error("MyMemory query length exceeded");
        return tr;
      };

      // MyMemory hard-limits q length (~500 chars). Split input into <=450-char chunks.
      const maxLen = 450;
      const src = text.replace(/\r\n/g, "\n").trim();
      const parts = src.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);
      /** @type {string[]} */
      const chunks = [];
      parts.forEach((p) => {
        if (p.length <= maxLen) {
          chunks.push(p);
          return;
        }
        // Further split long paragraphs by sentence punctuation.
        const sents = p.split(/(?<=[。！？!?])\s*/g).map((x) => x.trim()).filter(Boolean);
        let buf = "";
        sents.forEach((s) => {
          const next = buf ? `${buf} ${s}` : s;
          if (next.length <= maxLen) {
            buf = next;
            return;
          }
          if (buf) chunks.push(buf);
          // If a single sentence is still too long, hard-slice.
          if (s.length > maxLen) {
            for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
            buf = "";
          } else {
            buf = s;
          }
        });
        if (buf) chunks.push(buf);
      });

      /** @type {string[]} */
      const out = [];
      for (let i = 0; i < chunks.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const tr = await translateChunk(chunks[i]);
        out.push(tr);
        // small delay to be polite to free endpoint
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }

      const html = out.map((p) => `<p>${p}</p>`).join("");
      return html || "<p>(번역 실패)</p>";
    };

    const tryGemini = async () => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || isPlaceholderEnv(apiKey)) throw new Error("Missing env: GEMINI_API_KEY");
      const modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = [
        "너는 EJU 일본어 독해 학습용 번역가다.",
        "아래 일본어 지문을 한국어로 자연스럽게 번역하되, 과장 없이 학습용으로 명료하게 번역한다.",
        "- 출력은 HTML만. 각 문단은 <p>...</p>로 감싼다.",
        "- 원문 문단 수를 최대한 유지한다.",
        "- 고유명사/전문용어는 과하게 의역하지 말고 괄호로 보조 설명 가능.",
        "",
        "[원문]",
        text,
      ].join("\n");

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      });
      const out = String(result?.response?.text?.() || "").trim();
      if (!out) throw new Error("Empty translation");
      return out.includes("<p") ? out : `<p>${out.replaceAll("\n", "<br>")}</p>`;
    };

    // Prefer Gemini, but fall back to MyMemory when quota/rate-limited.
    try {
      const html = await tryGemini();
      return res.json({ html, provider: "gemini" });
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (msg.includes("[429 Too Many Requests]") || msg.includes("retryDelay")) {
        const html = await fallbackMyMemory();
        return res.json({ html, provider: "mymemory" });
      }
      // If Gemini key missing or other transient failure, also fall back.
      const html = await fallbackMyMemory();
      return res.json({ html, provider: "mymemory" });
    }
  } catch (e) {
    const msg = String(e?.message || e || "");
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/vocab
 * Body: { text: string, count?: number }
 * Returns: { vocab: Array<{ term: string, meaningKo: string }> }
 */
app.post("/api/vocab", async (req, res) => {
  try {
    const apiKey = mustGetEnv("GEMINI_API_KEY");
    const modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const text = String(req.body?.text || "").trim();
    const countIn = Number(req.body?.count);
    const count = Number.isFinite(countIn) ? Math.max(8, Math.min(18, Math.floor(countIn))) : 14;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const prompt = [
      "너는 EJU 일본어 독해 단어장을 만드는 조교다.",
      "아래 일본어 지문에서 학습 가치가 높은 단어/표현(한자어, 핵심 개념어)을 뽑아 단어장 JSON을 만든다.",
      "",
      "규칙:",
      `- 개수: ${count}개.`,
      "- 표기는 원문 그대로(일본어). 조사/활용형은 기본형으로 정리(예: 〜する, 〜的 등).",
      "- 너무 쉬운 단어(例えば, しかし 등) 제외.",
      "- 지문에 실제로 등장하는 단어/표현만 뽑아라(없는 단어를 만들지 마라).",
      "- 이념/사상 이름(예: 〜主義, 〜イズム)처럼 '정답 키워드'가 되기 어려운 단어는 제외.",
      "- EJU 독해에서 정답을 고를 때 '근거 문장'을 찾는 데 중요한 핵심어/핵심 표현을 우선.",
      "- 의미는 한국어로 짧고 정확하게.",
      "- 출력은 반드시 JSON만. 형식: [{\"term\":\"...\",\"meaningKo\":\"...\"}, ...]",
      "",
      "[지문]",
      text,
    ].join("\n");

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    });
    const raw = String(result?.response?.text?.() || "").trim();
    const jsonText = raw.replace(/^```json\\s*/i, "").replace(/^```\\s*/i, "").replace(/```\\s*$/i, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(500).json({ error: "Bad vocab JSON from model" });
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const stopRe = /(主義|イズム)$/;
    const vocab = arr
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ term: String(x.term || "").trim(), meaningKo: String(x.meaningKo || "").trim() }))
      .filter((x) => x.term && x.meaningKo)
      // prevent hallucinations: must appear in source text
      .filter((x) => text.includes(x.term))
      // heuristic stoplist requested by user
      .filter((x) => !stopRe.test(x.term))
      .slice(0, count);
    res.json({ vocab });
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (msg.includes("[429 Too Many Requests]") || msg.includes("retryDelay")) {
      const m = msg.match(/retryDelay\\\":\\\"(\\d+)s\\\"/);
      const retryAfterSec = m ? Number(m[1]) : undefined;
      if (Number.isFinite(retryAfterSec)) res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: msg, retryAfterSec });
    }
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/report
 * Body: { context: object, seed?: number, locale?: string }
 * Returns: { reportHtml: string, links: Array<{title,url,why}>, seed: number }
 *
 * Notes:
 * - We do NOT put API keys in the browser. This server holds the keys.
 * - If GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX are set, we fetch real links.
 * - Gemini then writes a personalized report using those links.
 */
app.post("/api/report", async (req, res) => {
  try {
    const cacheKey = crypto.createHash("sha256").update(JSON.stringify(req.body || {})).digest("hex");
    const cached = getCachedReport(cacheKey);
    if (cached) return res.json(cached);

    const apiKey = mustGetEnv("GEMINI_API_KEY");
    // v1beta model naming can differ; default to a commonly available alias.
    const modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const locale = (req.body?.locale || "ko").toString();
    const context = req.body?.context || {};

    const seedIn = Number(req.body?.seed);
    const seed = Number.isFinite(seedIn) ? (seedIn >>> 0) : shaSeed(JSON.stringify(context));

    const focusSkills = Array.isArray(context?.focus?.skillsTop) ? context.focus.skillsTop : [];
    const focusTopics = Array.isArray(context?.focus?.topicsTop) ? context.focus.topicsTop : [];

    // Build search queries (deterministic-ish but seed affects order)
    const baseQueries = [
      ...focusSkills.map((s) => `EJU 読解 解き方 ${s}`),
      ...focusTopics.map((t) => `${t} 日本 読解 表現 例`),
      ...focusTopics.map((t) => `${t} 日本 ドラマ おすすめ 日本語字幕`),
      ...focusTopics.map((t) => `${t} 日本 アニメ おすすめ セリフ 表現`),
      ...focusTopics.map((t) => `${t} 日本 バラエティ おすすめ 会話 表現`),
      "日本語 ドラマ 日常会話 日本語字幕 おすすめ 作品名",
      "日本語 バラエティ よく使う 表現 作品名",
      "日本語 アニメ 日常 表現 作品名"
    ].filter(Boolean);

    const cseKey = process.env.GOOGLE_CSE_API_KEY || "";
    const cseCx = process.env.GOOGLE_CSE_CX || "";
    let searched = [];
    const canSearch = Boolean(cseKey && cseCx && !isPlaceholderEnv(cseKey) && !isPlaceholderEnv(cseCx));
    if (canSearch) {
      try {
        // fetch a few queries, merge unique URLs
        const seen = new Set();
        for (const q of baseQueries.slice(0, 4)) {
          const items = await googleCseSearch({ apiKey: cseKey, cx: cseCx, q, num: 5 });
          for (const it of items) {
            if (!it.url || seen.has(it.url)) continue;
            seen.add(it.url);
            searched.push(it);
          }
        }
        searched = searched.slice(0, 10);
      } catch {
        searched = [];
      }
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    function isNonEmptyString(s) {
      return typeof s === "string" && s.trim().length > 0;
    }

    function validateReport(r) {
      const errors = [];
      if (!r || typeof r !== "object") errors.push("report missing");
      const contentPlan = Array.isArray(r?.contentPlan) ? r.contentPlan : [];
      const studyItems = Array.isArray(r?.studyPlan2) ? r.studyPlan2 : [];
      const checklistItems = Array.isArray(r?.checklistItems) ? r.checklistItems : [];

      if ((Array.isArray(r?.summaryLines) ? r.summaryLines.length : 0) < 4) errors.push("summaryLines too short");
      if (checklistItems.length < 6) errors.push("checklistItems < 6");
      for (const it of checklistItems) {
        if (!isNonEmptyString(it?.title)) errors.push("checklistItems.title missing");
        if (!isNonEmptyString(it?.why)) errors.push("checklistItems.why missing");
        if (!isNonEmptyString(it?.how)) errors.push("checklistItems.how missing");
      }

      if (contentPlan.length < 3) errors.push("contentPlan < 3");
      for (const p of contentPlan) {
        const links = Array.isArray(p?.links) ? p.links : [];
        const queries = Array.isArray(p?.queries) ? p.queries : [];
        if (!isNonEmptyString(p?.title)) errors.push("contentPlan.title missing");
        if (links.length < 7) errors.push("contentPlan.links < 7");
        if (queries.length < 6) errors.push("contentPlan.queries < 6");
      }

      if (studyItems.length < 4) errors.push("studyPlan2 < 4");
      for (const it of studyItems) {
        const tips = Array.isArray(it?.tips) ? it.tips : [];
        const examples = Array.isArray(it?.examples) ? it.examples : [];
        if (!isNonEmptyString(it?.title)) errors.push("studyPlan2.title missing");
        if (!isNonEmptyString(it?.body)) errors.push("studyPlan2.body missing");
        if (tips.length < 2) errors.push("studyPlan2.tips < 2");
        if (examples.length < 2) errors.push("studyPlan2.examples < 2");
        for (const e of examples) {
          if (!isNonEmptyString(e?.jp) || !isNonEmptyString(e?.ko)) errors.push("studyPlan2.example missing jp/ko");
        }
      }
      return errors;
    }

    function tryParseJson(text) {
      const t = String(text || "").trim();
      if (!t) return null;
      // Common model behavior: wrap JSON in code fences or add brief preface.
      const unfenced = t
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      try {
        return JSON.parse(unfenced);
      } catch {
        // Try extracting the first top-level object.
        const m = unfenced.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
          return JSON.parse(m[0]);
        } catch {
          return null;
        }
      }
    }

    async function generateJson(promptText) {
      const out = await withTimeout(model.generateContent(promptText), 20000, "gemini generateContent timeout");
      const text = out.response.text();
      const json = tryParseJson(text);
      return { json, raw: text };
    }

    const prompt = [
      "너는 일본어 독해(EJU) 학습 코치이다.",
      "사용자 기록(JSON)과 (가능하면) 실제 웹 검색 결과를 바탕으로, 한국어 리포트를 작성한다.",
      "",
      "제약:",
      "- 말투는 정형화한다: ‘~이다/~한다/~로 본다/~로 처리한다’",
      "- 과장 금지. 불확실하면 ‘가능성이 높다/낮다’로 표현한다.",
      "- 아래 출력 포맷(JSON)만 출력한다. 다른 텍스트 금지.",
      "- HTML을 직접 만들지 않는다. (프론트 템플릿에서 렌더링한다)",
      "",
      "출력 JSON 스키마:",
      "{",
      '  "report": {',
      '    "summaryLines": ["...","...","...","..."],',
      '    "stats": {"scoreText":"...","accuracyText":"...","doneText":"...","focusSkillText":"...","focusTopicText":"..."},',
      '    "weaknessBullets": ["...","...","..."],',
      '    "mistakeBullets": ["...","..."],',
      '    "checklistItems": [',
      '      {"title":"...","why":"...","how":"..."},',
      '      {"title":"...","why":"...","how":"..."}',
      "    ],",
      '    "contentPlan": [',
      '      {',
      '        "title":"...",',
      '        "reason":"...",',
      '        "method":"...",',
      '        "linkWhy":"...",',
      '        "links":[{"title":"...","url":"..."}],',
      '        "queries":["...","..."]',
      '      }',
      '    ],',
      '    "studyPlan2": [',
      '      {',
      '        "title":"...",',
      '        "body":"...",',
      '        "tips":["...","...","..."],',
      '        "examples":[{"jp":"...","ko":"..."}]',
      '      }',
      '    ]',
      '  },',
      '  "links": [{"title":"...","url":"...","why":"..."}],',
      '  "seed": 123',
      "}",
      "",
      `seed=${seed}`,
      "",
      "사용자 기록(JSON):",
      JSON.stringify(context),
      "",
      "웹 검색 결과(있으면 사용):",
      JSON.stringify(searched),
      "",
      "리포트 요구사항:",
      "- report.summaryLines는 4~7문장. 분석적으로 길게 쓴다.",
      "- 요약에 반드시 포함: 사용자의 오답 패턴 → 일본어 독해에서 일본인이 답을 고르는 사고(근거 중심/범위 엄수/단정 회피) → 사용자가 흔히 빠지는 함정(범위 초과/원인-결과 전도/부분-전체 확대/표현 강도) → 다음 행동.",
      "- report.stats는 화면에 그대로 쓸 짧은 텍스트로 작성.",
      "- report.weaknessBullets는 3~6개.",
      "- report.mistakeBullets는 최근 오답을 바탕으로 3~5개(데이터가 없으면 1개).",
      "- report.checklistItems는 6~10개.",
      "- checklistItems는 ‘질문형 체크리스트(무엇을 확인했는가?)’ + ‘왜 필요한가(일본식 정답 사고: 근거/범위/표현 강도/중립성)’ + ‘어떻게 확인하는가(본문에서 찾을 위치/표지어/판정 규칙)’ 3요소로 쓴다.",
      "- report.contentPlan은 3~5개 플랜. 각 플랜은 분량을 충분히 길게 쓴다.",
      "- contentPlan은 뉴스/교재 링크만으로 채우지 않는다. 각 플랜의 links 중 최소 절반은 ‘작품 단위 추천’(드라마/애니/버라이어티/영화/다큐 등 개별 콘텐츠 제목)으로 구성한다.",
      "- NHK(Easy 포함) 위주로 편향하지 않는다. 사용자의 약점 주제에 맞춘 대중 콘텐츠를 우선 배치한다.",
      "- 각 플랜 links는 최소 7개(가능하면 9~10개). 링크 제목에는 플랫폼/매체를 함께 적는다. 예: ‘Netflix · 작품명’, ‘YouTube · 영상 제목’, ‘Wikipedia/공식 사이트 · 작품 페이지’.",
      "- 각 플랜 queries는 6~10개(구체적인 검색어)로 작성한다.",
      "- report.studyPlan2는 4~7개 항목.",
      "- studyPlan2는 ‘단계 나열’로 끝내지 않는다. 각 항목은 (해석 습관/정답 근거 찾기/보기 제거 기준/문장 구조 잡기/표현 강도 판단/일본식 글 전개)처럼 스킬 중심으로 길게 설명한다.",
      "- 각 항목은 tips(최소 2개)와 examples(최소 2개)를 포함한다. examples는 항목 바로 아래에서 쓰일 수 있도록 항목 내용과 연결된 문장으로 만든다.",
      "- links 배열은 contentPlan의 links와 중복 가능하나, why를 포함한다.",
      "- 링크는 searched의 url을 우선 사용한다. 부족하면 google/youtube 검색 결과 링크를 생성한다.",
      `- locale=${locale}`
    ].join("\n");

    const first = await generateJson(prompt);
    let parsed = first.json;
    let lastRaw = first.raw || "";

    // Repair loop: if schema is present but plans are too short/empty, retry once with explicit fix instructions.
    if (parsed && parsed.report && typeof parsed.report === "object") {
      const errs = validateReport(parsed.report);
      if (errs.length) {
        const repairPrompt = [
          prompt,
          "",
          "수정 지시:",
          "- 방금 출력은 요구사항을 충족하지 못했다. 아래 항목을 반드시 고쳐서 다시 JSON만 출력한다.",
          `- 부족한 항목: ${errs.join(", ")}`,
          "- contentPlan은 3~5개 플랜이며, 각 플랜은 링크 7개 이상/검색어 6개 이상을 채운다.",
          "- 링크는 뉴스/교재 편향을 피하고, 드라마/애니/버라이어티 같은 ‘작품 단위’ 추천을 최소 절반 포함한다.",
          "- summaryLines는 4~7문장으로 길게 쓴다.",
          "- studyPlan2는 4~7개 항목이며, 각 항목은 tips 2개 이상 + examples 2개 이상(jp/ko 모두)로 채운다.",
          "",
          "이전 출력(참고용, 그대로 재사용 금지):",
          JSON.stringify(parsed).slice(0, 8000)
        ].join("\n");
        const second = await generateJson(repairPrompt);
        if (second.raw) lastRaw = second.raw;
        if (second.json) parsed = second.json;
      }
    }

    if (!parsed || typeof parsed !== "object" || !parsed.report || typeof parsed.report !== "object") {
      return res.json({
        seed,
        report: {
          summaryLines: ["리포트 생성 결과가 JSON 형식으로 반환되지 않았다.", "서버 프롬프트를 점검해야 한다."],
          stats: {
            scoreText: "-",
            accuracyText: "-",
            doneText: "-",
            focusSkillText: "-",
            focusTopicText: "-",
          },
          weaknessBullets: ["생성 실패로 진단을 확정할 수 없다."],
          mistakeBullets: ["생성 실패로 오답 요약을 확정할 수 없다."],
          checklistItems: [],
          contentPlan: [],
          studyPlan2: [],
        },
        links: [],
        raw: String(lastRaw || "")
      });
    }

    const finalErrs = validateReport(parsed.report);
    if (finalErrs.length) {
      return res.json({
        seed,
        report: {
          summaryLines: ["리포트 생성 결과가 요구사항을 충족하지 못했다.", `부족 항목: ${finalErrs.join(", ")}`],
          stats: {
            scoreText: "-",
            accuracyText: "-",
            doneText: "-",
            focusSkillText: "-",
            focusTopicText: "-",
          },
          weaknessBullets: ["생성 실패로 진단을 확정할 수 없다."],
          mistakeBullets: ["생성 실패로 오답 요약을 확정할 수 없다."],
          checklistItems: [],
          contentPlan: [],
          studyPlan2: [],
        },
        links: [],
        raw: String(lastRaw || "")
      });
    }

    const payload = { seed, ...parsed };
    setCachedReport(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    const msg = String(e?.message || e || "");
    // If Gemini rate-limits, propagate as 429 with retry hint.
    if (msg.includes("[429 Too Many Requests]") || msg.includes("retryDelay")) {
      const m = msg.match(/retryDelay\":\"(\d+)s\"/);
      const retryAfterSec = m ? Number(m[1]) : undefined;
      if (Number.isFinite(retryAfterSec)) res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: msg, retryAfterSec });
    }
    res.status(500).json({ error: msg });
  }
});

// After API routes: serve the static mock-exam site from repo root (local + Docker + PaaS).
// IMPORTANT (PaaS):
// - Avoid aggressive caching for HTML/JS/CSS to prevent clients seeing stale UI after deploy.
app.use((req, res, next) => {
  try {
    const p = String(req.path || "");
    if (p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store");
    }
  } catch {
    // ignore
  }
  next();
});
app.use(
  express.static(publicDir, {
    extensions: ["html"],
    index: ["index.html"],
    // Allow serving dotfiles used as local import artifacts (e.g. .tmp_tangosi2_vocab.json).
    dotfiles: "allow",
    maxAge: 0,
  }),
);

const port = Number(process.env.PORT || "8787");
const host = process.env.BIND_HOST || "0.0.0.0";
app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`EJU server (static + /api) listening on http://${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`Open http://127.0.0.1:${port}/index.html`);
});

