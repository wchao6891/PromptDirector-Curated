# PromptDirector Curated

PromptDirector 的公开精选案例目录。

这个仓库只保存维护者审核后可公开分发的目录、封面和发布材料。插件源码、私人案例、评测资料、同步数据和 API 密钥不属于本仓库。

## 权利与下架

原创案例和第三方网络分享案例会明确区分。第三方案例保留原作者和来源，相关权利归原作者或其他权利人所有；收录不代表已获得商业授权。完整说明见 [RIGHTS.md](RIGHTS.md)。

权利人可通过 [权利反馈 Issue](https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=rights-report.yml) 联系维护者核实与下架。

## 发布流程

1. 在 PromptDirector 中把一期候选图片或视频案例整理为项目并导出普通项目分享包。
2. 维护者使用 `tools/build-curated-batch.mjs` 读取分享包和当期配置，检查隐私、来源、重复内容、视频封面与包完整性，并生成发布材料。
3. 维护者人工复核案例质量、权利与来源说明，为每一期确认名称。
4. 通过审核的 ZIP 作为 GitHub Release 附件发布。
5. 使用审核后的 ZIP 生成 `site/previews/` 只读预览；视频只发布封面，提示词只作为文字展示和复制。
6. 维护者将封面放入 `site/covers/`，并把带 SHA-256 校验值、稳定作者编号和预览地址的记录加入 `site/catalog.json`。
7. GitHub Action 从 Release Asset API 更新经过摘要核对的累计下载量；失败时不覆盖上次真实快照。

目录不会自动收录投稿。普通插件不提供投稿或审核入口，也不提供点赞、评论、公开粉丝数或算法排行榜。关注只保存在当前设备。
