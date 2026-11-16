#!/usr/bin/env bash
# ============================================================
#  智诊通 · 一键启动（macOS / Linux）
#
#  设计原则与 Windows 版一致：不硬编码任何本机路径，全部运行时探测。
#  只要装了 Node 就能起前端；装了 JDK 17 + Maven 会自动带起后端。
# ============================================================

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m'

line()  { printf "  %s\n" "$(printf '%*s' 56 '' | tr ' ' '-')"; }
head_() { printf "\n  ${CYAN}%s${NC}\n" "$1"; line; }
ok()    { printf "  ${GREEN}[OK]${NC}   %s\n" "$1"; }
warn()  { printf "  ${YELLOW}[!]${NC}    %s\n" "$1"; }
fail()  { printf "  ${RED}[X]${NC}    %s\n" "$1"; }
hint()  { printf "         ${GRAY}%s${NC}\n" "$1"; }

printf "\n  ${GREEN}============================================${NC}\n"
printf "  ${GREEN}  智诊通 · 患者端智能导诊系统${NC}\n"
printf "  ${GREEN}============================================${NC}\n"

# ---------- 1. Node ----------
head_ "检查运行环境"

if ! command -v node >/dev/null 2>&1; then
  fail "未找到 Node.js"
  hint "前端必须依赖 Node.js 18 或更高版本"
  hint "下载：https://nodejs.org/zh-cn/download"
  hint "或用包管理器：brew install node / apt install nodejs"
  exit 1
fi

NODE_VER="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  fail "Node.js 版本过低：$NODE_VER（需要 18+）"
  hint "请升级后重试"
else
  ok "Node.js $NODE_VER"
fi

# ---------- 2. pnpm ----------
if ! command -v pnpm >/dev/null 2>&1; then
  warn "未找到 pnpm，尝试用 Node 自带的 corepack 启用"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm >/dev/null 2>&1 || true
    corepack prepare pnpm@9.15.0 --activate >/dev/null 2>&1 || true
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
  PM="pnpm"
else
  warn "pnpm 不可用，改用 npx 执行（首次会稍慢）"
  PM="npx --yes pnpm@9"
fi

# ---------- 3. 前端依赖 ----------
FE_DIR="$ROOT/frontend"

if [ ! -d "$FE_DIR/node_modules" ]; then
  warn "前端依赖未安装，正在自动安装（首次约 1-3 分钟）"
  ( cd "$FE_DIR" && $PM install )
  if [ $? -ne 0 ]; then
    fail "依赖安装失败"
    hint "请手动执行：cd frontend && pnpm install"
    exit 1
  fi
  ok "依赖安装完成"
else
  ok "前端依赖已就绪"
fi

# ---------- 4. JDK ----------
JAVA_EXE=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_EXE="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_EXE="$(command -v java)"
fi

JDK_OK=0
if [ -n "$JAVA_EXE" ]; then
  VERLINE="$("$JAVA_EXE" -version 2>&1 | head -1)"
  if printf '%s' "$VERLINE" | grep -qE 'version "1\.([0-9]+)'; then
    JV="$(printf '%s' "$VERLINE" | sed -E 's/.*version "1\.([0-9]+).*/\1/')"
  else
    JV="$(printf '%s' "$VERLINE" | sed -E 's/.*version "([0-9]+).*/\1/')"
  fi
  if [ "${JV:-0}" -ge 17 ] 2>/dev/null; then
    JDK_OK=1
    ok "JDK $JV"
  else
    warn "JDK 版本过低（${JV:-未知}），后端需要 17+"
  fi
else
  warn "未找到 JDK —— 后端不启动"
  hint "前端仍可使用问诊、健康管家、就诊摘要"
  hint "需要病历与预约页时，装 JDK 17：https://adoptium.net/"
fi

# ---------- 5. Maven ----------
MVN_EXE=""
for c in "${MVN:-}" "${MAVEN_HOME:-}/bin/mvn" "$ROOT/.tools/apache-maven/bin/mvn"; do
  if [ -n "$c" ] && [ -x "$c" ]; then MVN_EXE="$c"; break; fi
done
if [ -z "$MVN_EXE" ] && command -v mvn >/dev/null 2>&1; then
  MVN_EXE="$(command -v mvn)"
fi

if [ -n "$MVN_EXE" ]; then
  ok "Maven 已找到"
  hint "$MVN_EXE"
else
  warn "未找到 Maven —— 后端不启动"
  hint "安装 Maven 3.9+：https://maven.apache.org/download.cgi"
  hint "或把解压后的目录放到 .tools/apache-maven，脚本会自动识别"
fi

# ---------- 6. 端口检查 ----------
for p in 5173 8080; do
  if command -v lsof >/dev/null 2>&1; then
    if lsof -i ":$p" -sTCP:LISTEN >/dev/null 2>&1; then
      warn "端口 $p 已被占用（可能是上次没关干净）"
    fi
  fi
done

# ---------- 7. 启动 ----------
head_ "启动服务"

BACKEND_PID=""
if [ "$JDK_OK" -eq 1 ] && [ -n "$MVN_EXE" ] && [ -f "$ROOT/backend/pom.xml" ]; then
  if [ -n "${JAVA_HOME:-}" ]; then export JAVA_HOME; fi
  ( cd "$ROOT/backend" && "$MVN_EXE" -B spring-boot:run ) &
  BACKEND_PID=$!
  ok "后端已在后台启动（PID $BACKEND_PID）"
  hint "首次启动约 20-40 秒就绪"
else
  warn "后端跳过（缺少 JDK 17 或 Maven）"
  hint "前端仍可启动：问诊可用，病历与预约页会提示后端未启动"
fi

printf "\n  前端启动中...\n\n"
printf "  --------------------------------------------\n"
printf "   访问地址： http://localhost:5173\n"
printf "   演示账号： demo / demo1234\n"
printf "   停止前端： Ctrl+C\n"
if [ -n "$BACKEND_PID" ]; then
  printf "   注意：     Ctrl+C 只停前端，后端请执行 kill %s\n" "$BACKEND_PID"
fi
printf "  --------------------------------------------\n\n"

# 前端就绪后自动打开浏览器（后台轮询）
(
  for _ in $(seq 1 120); do
    if command -v curl >/dev/null 2>&1; then
      if curl -sf -o /dev/null --max-time 2 http://localhost:5173/; then
        if command -v open >/dev/null 2>&1; then open http://localhost:5173/;
        elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5173/ >/dev/null 2>&1;
        fi
        break
      fi
    fi
    sleep 1
  done
) >/dev/null 2>&1 &

# shellcheck disable=SC2086
cd "$FE_DIR" && $PM dev
