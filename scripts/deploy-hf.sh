#!/usr/bin/env bash
# ------------------------------------------------------------------
# 把当前提交推到 Hugging Face Space（免费 Docker 托管）
#
# 用法：
#   HF_TOKEN=hf_xxx ./scripts/deploy-hf.sh <用户名> <space 名>
#
# 例：
#   HF_TOKEN=hf_xxx ./scripts/deploy-hf.sh dessert28 zhidao-demo
#
# 为什么不是直接 `git push hf master`：
#   HF Space 靠仓库根 README.md 的 frontmatter 识别 sdk 与端口。
#   直接推主仓库会让 HF 读到项目的开发 README（没有 frontmatter），
#   Space 会被当成 static 站点，构建必然失败。
#   所以这里导出**当前提交的快照**，再单独覆盖一份 Space 专用 README。
#
# 用的是 git archive 而不是 rsync：Windows 的 Git Bash 默认没有 rsync。
# ------------------------------------------------------------------
set -euo pipefail

USER_NAME="${1:-}"
SPACE_NAME="${2:-}"
if [ -z "$USER_NAME" ] || [ -z "$SPACE_NAME" ]; then
  echo "用法：HF_TOKEN=hf_xxx $0 <用户名> <space 名>" >&2
  exit 1
fi

if [ -z "${HF_TOKEN:-}" ]; then
  echo "缺少 HF_TOKEN。到 https://huggingface.co/settings/tokens 建一个 write 权限的 token。" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 构建上下文来自 committed 内容，避免把本机临时文件一起推上去
if [ -n "$(git status --porcelain)" ]; then
  echo "注意：工作区有未提交改动，本次只推送 HEAD 的内容。" >&2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "导出 HEAD 快照…"
git archive HEAD | tar -x -C "$TMP"

echo "覆盖 Space 专用 README…"
cp deploy/hf/README.md "$TMP/README.md"

cd "$TMP"
git init -q -b main
git add -A
git -c user.name="zhidao-deploy" -c user.email="deploy@local" \
    commit -q -m "deploy: $(date '+%Y-%m-%d %H:%M')"

REMOTE="https://${USER_NAME}:${HF_TOKEN}@huggingface.co/spaces/${USER_NAME}/${SPACE_NAME}"

echo "推送到 ${USER_NAME}/${SPACE_NAME} …"
git push --force "$REMOTE" main

echo
echo "完成。Space 地址： https://huggingface.co/spaces/${USER_NAME}/${SPACE_NAME}"
echo "构建日志： https://huggingface.co/spaces/${USER_NAME}/${SPACE_NAME}/logs"
echo "首次构建约 8~15 分钟（要下 Maven 依赖），之后每次重建约 2 分钟。"
echo "可访问地址： https://${USER_NAME}-${SPACE_NAME}.hf.space"
