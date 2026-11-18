# ==================================================================
#  前端镜像（Vite 静态产物 + Node BFF）
#
#  与 backend/Dockerfile 配套：两个服务分别部署、内网互通。
#  后端地址通过 BACKEND_BASE_URL 注入（形如 http://<服务名>:8080），
#  BFF 服务端转发，浏览器不跨域。
#
#  构建：docker build -f frontend/Dockerfile -t zhidao-frontend frontend/
#  运行：docker run -p 7860:7860 -e BACKEND_BASE_URL=http://backend:8080 zhidao-frontend
# ==================================================================

# ------------------------------------------------------------------
# 阶段一：构建静态产物
# ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src

# 锁文件指定 pnpm 9.15.0，用 corepack 对齐，避免"本地能装、镜像装不上"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# 先只拷清单，让依赖层命中缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# 不能用 --prod：start 走的是 devDependencies 里的 tsx（docs/14 §1.3）
RUN pnpm build

# ------------------------------------------------------------------
# 阶段二：运行时
# ------------------------------------------------------------------
FROM node:22-bookworm-slim

# curl 给健康检查与排障用，镜像里没有 curl 时连不上会很难查
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 整个 /src 都拷过来：运行时需要 src（tsx 直接跑 TS）、dist、node_modules
COPY --from=build /src /app

# 端侧模型缓存目录：非 root 用户运行时 mkdirSync 会失败（表现为模型加载 500）
RUN mkdir -p /app/.cache/models /app/.cache/tmp \
 && chown -R 1000:1000 /app

ENV NODE_ENV=production \
    PORT=7860 \
    MODEL_ORIGIN=https://modelscope.cn

# 只跑 BFF，不再拉起 JVM —— 后端是独立服务，地址由 BACKEND_BASE_URL 给
EXPOSE 7860

CMD ["node", "--import", "tsx", "server/standalone.ts"]
