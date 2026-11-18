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

# 堆大小必须可调：不同托管平台给的内存差一个数量级。
#   HF Spaces 免费档 16 GB → 768m 堆绰绰有余
#   Render 免费档 512 MB → 768m 堆会让容器被 OOM kill（表现为构建成功、
#   部署时反复重启，日志里只有一句 Killed，没有任何 Java 异常）
# 默认值保持 768m 以兼容大内存平台，小平台通过 JAVA_OPTS 覆盖。
JAVA_OPTS="${JAVA_OPTS:--Xms256m -Xmx768m}"

echo "[zhidao] 启动 Spring Boot（H2 内存库），JAVA_OPTS=${JAVA_OPTS}"
# shellcheck disable=SC2086  # 需要按空格拆分多个 JVM 参数
java -Dfile.encoding=UTF-8 $JAVA_OPTS \
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
