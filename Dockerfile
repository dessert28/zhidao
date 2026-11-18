# ==================================================================
#  智诊通 · 一体化镜像（前端 dist + Node BFF + Spring Boot）
#
#  为什么是两个进程塞进一个镜像，而不是两个容器：
#    目标平台是 Hugging Face Spaces 的免费 Docker Space，
#    一个 Space 只能跑**一个**容器。而按 docs/10 §0.4 的定论，
#    前端静态产物与 BFF 必须同进程（同源，无跨域，SSE 直连），
#    所以 Node 是主进程，Spring Boot 作为它的上游子进程。
#    生产环境（docs/14）里这两个进程是分开的，由 systemd 管 —— 那才是正规做法。
#
#  构建：docker build -t zhidao .
#  运行：docker run -p 7860:7860 -e LLM_API_KEY=xxx zhidao
# ==================================================================

# ------------------------------------------------------------------
# 阶段一：后端。--mount 缓存不加，因为 HF 的构建器不一定支持 cache mount，
# 加了会直接构建失败；宁可慢一点也不要构建不出来。
# ------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS backend-build
WORKDIR /src

# 先只拷 pom：依赖层能命中缓存，改代码不必重下依赖
COPY backend/pom.xml ./
RUN mvn -B -ntp -q dependency:go-offline || true

COPY backend/src ./src
# 跳过测试：测试已在 CI 与本地跑过，镜像构建只负责产出可运行的 jar
RUN mvn -B -ntp -q clean package -DskipTests

# ------------------------------------------------------------------
# 阶段二：前端。tsc -b && vite build → dist/
# ------------------------------------------------------------------
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /src

# 锁文件指定的 pnpm 版本是 9.15.0，用 corepack 对齐，避免"本地能装、镜像装不上"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# 同理，先只拷清单，让依赖层缓存起来
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/ ./
# 这里不能用 --prod：start 脚本走的是 tsx，而 tsx 在 devDependencies 里
# （docs/14 §1.3 记过这条真实约束，不要用"生产只装 dependencies"的通用习惯）
RUN pnpm build

# ------------------------------------------------------------------
# 阶段三：运行时。Node 20 + JRE 17
# ------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# JRE 而非 JDK：运行时只需要能跑 jar，省 ~200MB
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=backend-build /src/target/zhidao-backend-0.1.0.jar /app/backend.jar
COPY --from=frontend-build /src /app/frontend
COPY deploy/hf/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 端侧模型缓存目录：HF 用 uid 1000 跑容器，不预先建好并授权，
# models.ts 里的 mkdirSync 会失败（表现为模型加载 500）
RUN mkdir -p /app/frontend/.cache/models /app/frontend/.cache/tmp \
 && chown -R 1000:1000 /app

# HF Spaces 的约定端口。standalone.ts 读 process.env.PORT，改这里即可换端口
ENV PORT=7860 \
    NODE_ENV=production \
    H2_URL="jdbc:h2:mem:zhidao;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE" \
    APP_SEED_MODE=always \
    BACKEND_BASE_URL=http://127.0.0.1:8080 \
    MODEL_ORIGIN=https://modelscope.cn

EXPOSE 7860

# 单一入口：先拉起后端，再 exec 前端（exec 让 Node 接管 PID 1，
# 收到 SIGTERM 才能优雅退出，否则 HF 重启容器时要等 10 秒超时才强杀）
CMD ["/app/entrypoint.sh"]
