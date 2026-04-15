# Monolith: static mock exam + POST /api/report (Gemini) on one port.
FROM node:20-alpine
WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY api-config.js ./
COPY app.js styles.css eju_full.txt ./
COPY index.html exam.html result.html vocab.html vocab-quiz.html ./
COPY siken3_normalized.json siken3_vocab.json tansi1_vocab.json ./

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server/index.js"]
