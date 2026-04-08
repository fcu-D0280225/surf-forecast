FROM node:20-alpine AS builder

# better-sqlite3 需要編譯工具
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

# 只複製必要檔案（data/ 和 public/data/ 由 volume 掛載，不進 image）
COPY --from=builder /app/node_modules ./node_modules
COPY src/           ./src/
COPY scripts/       ./scripts/
COPY public/        ./public/
COPY package.json   ./

# 確保 SQLite 資料目錄存在
RUN mkdir -p data

EXPOSE 4000

# tini 處理 signal（避免 Node 殭屍進程）
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
