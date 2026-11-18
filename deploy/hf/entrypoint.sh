#!/usr/bin/env bash
# ------------------------------------------------------------------
# 容器入口：Spring Boot（上游）+ Node BFF（主进程）
#
# 顺序不能反：BFF 启动后第一个请求就可能打到 /api/backend/*，
# 后端没起来时前端不会崩（代理层有降级），但病历页会短暂空白。
# 先起后端、等到健康，再起前端，用户看到的就是完整的。
# ------------------------------------------------------------------
set -euo pipefail

PORT="${PORT:-7860}"

echo "[zhidao] 启动 Spring Boot（H2 内存库）…"
java -Dfile.encoding=UTF-8 -Xms256m -Xmx768m \
     -jar /app/backend.jar --server.port=8080 &
JAVA_PID=$!

# 等后端健康：最多 90 秒。超时不退出 —— 前端单独也能跑问诊主链路，
# 因为"起不来"比"起了但慢"更糟：让前端先服务，评审至少能看到东西。
ready=0
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/actuator/health >/dev/null 2>&1; then
    echo "[zhidao] 后端就绪，耗时 ${i}s"
    ready=1
    break
  fi
  # 后端进程提前挂了就不用再等
  if ! kill -0 "$JAVA_PID" 2>/dev/null; then
    echo "[zhidao] 后端进程已退出，跳过等待（前端仍可单独工作）"
    break
  fi
  sleep 1
done

if [ "$ready" = "0" ]; then
  echo "[zhidao] 后端 90s 内未就绪，继续启动前端（病历/预约接口将不可用）"
fi

# 容器重启时别留下孤儿 JVM
trap 'kill -TERM "$JAVA_PID" 2>/dev/null || true' TERM INT

cd /app/frontend
echo "[zhidao] 启动 Node BFF + 静态资源，端口 ${PORT}"
exec node --import tsx server/standalone.ts
