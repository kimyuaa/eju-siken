# Deploy (static site + Gemini API)

One Node process serves the HTML/CSS/JS from the repo root **and** `POST /api/report`. In the browser, open your deployed origin (e.g. `https://your-app.up.railway.app`); `app.js` calls `/api/report` on the **same host** (no API key in the frontend).

## Environment variables (set in the host dashboard, not in Git)

Required:

- `GEMINI_API_KEY`

Optional:

- `GEMINI_MODEL` (default: `gemini-flash-latest`)
- `PORT` (many hosts set this automatically; local/Docker default `8787`)
- `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX` (optional, for real web search links)

Never commit `server/.env`. Use the provider’s secret UI.

## Docker (local smoke test)

```bash
docker build -t eju-siken .
docker run --rm -p 8787:8787 -e GEMINI_API_KEY="your_key" eju-siken
```

Open `http://127.0.0.1:8787/index.html`, finish a run, then **Gemini report** on the result page.

## Railway / Render / Fly

1. Connect this repo.
2. Deploy using the **Dockerfile** (CMD runs `node server/index.js`; static files are copied into the image).
3. Add `GEMINI_API_KEY` (and optional vars).
4. Use the HTTPS URL the platform gives you.

## GitHub Pages only (static hosting)

GitHub Pages cannot run your Express server. Host the API elsewhere (Railway, etc.), then edit `api-config.js` in the repo (or the Pages branch) to set:

```js
window.__REPORT_API_URL__ = "https://your-api.up.railway.app/api/report";
```

`result.html` loads `api-config.js` before `app.js`. The server already enables `cors()` for cross-origin calls.

## Local dev

- **Live Server** on another port: the app still calls `http://127.0.0.1:8787/api/report` (run `cd server && npm run dev` in another terminal).
- **All-in-one:** `cd server && npm run dev` → open `http://127.0.0.1:8787/index.html`.
