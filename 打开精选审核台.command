#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print '需要先安装 Node.js 22 或更新版本。说明见 docs/review-desk.md。'
  read '?按回车关闭'
  exit 1
fi
node tools/review-desk/server.mjs
read '?审核台已停止，按回车关闭'
