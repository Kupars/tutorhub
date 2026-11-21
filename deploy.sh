#!/usr/bin/env bash
set -e

REPO_NAME="${1:-tutor-hub}"

echo "=== 一键自动推送到 GitHub（无需手动上传）==="
if ! command -v gh >/dev/null 2>&1; then
  echo "未检测到 gh 命令，请先执行: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "请按提示完成 GitHub 浏览器授权登录："
  gh auth login --web -p https
fi

if [ ! -d ".git" ]; then
  git init -b main
fi

git add .
git commit -m "Deploy tutor site for kupars.top" || true

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
else
  git push -u origin main
fi

echo ""
echo "✅ 代码已自动推送到 GitHub！GitHub Pages 将自动构建上线。"
echo "下一步：打开 Cloudflare Pages 关联该仓库并绑定域名 kupars.top 即可开启大陆加速与免费 AI 边缘接口。"
