# nihongo

EJU 일본어 독해 **단계형 템플릿**.

## 실행

```bash
python3 -m http.server 5173
```

브라우저에서 `http://localhost:5173`

## (옵션) Gemini 자동 리포트 서버

정적 페이지에서 **실시간 검색 + Gemini 생성**을 하려면 API 키를 브라우저에 둘 수 없어서, 로컬/배포용 서버가 1개 필요합니다.

### 필요한 것
- **Gemini API Key**: Google AI Studio에서 발급
- (권장) **Google Custom Search JSON API** 키 + CX(검색엔진 ID): 실제 웹 링크를 “검색해서” 가져오기 위함

### 실행

```bash
cd server
npm install
cp .env.example .env
# .env에 키 입력 (GEMINI_MODEL 기본값: gemini-flash-latest)
npm run dev
```

서버: `http://127.0.0.1:8787/api/health`

## 동작

- 문제 1(문항 2개) 풀이 → **채점**
- 채점 후
  - 각 문항 안에서 **정답/오답 + 내 답/정답/해설** 표시
  - 지문 바로 아래에 **전체 해석(파란색)** 표시
- **다음 문제**로 이동 후 반복

