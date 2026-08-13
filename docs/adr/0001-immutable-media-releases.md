# ADR 0001：精选视频使用不可变 GitHub Release

状态：采用

## 决策

精选视频从 SHA-256 校验通过的审核 ZIP 提取，以内容哈希命名，按精选包发布到独立 GitHub Media Release。仓库启用 Immutable Releases；每次先上传为草稿，核对资产大小与 GitHub 返回的 SHA 摘要，再发布并验证匿名 Range 播放。

GitHub 的 Release Asset 元数据保留 `video/mp4`，实际下载域统一返回 `application/octet-stream`。因此媒体类型不依赖下载响应头判断，而由发布前 `ffprobe` 的 H.264 MP4 验真、GitHub Asset 元数据和真实 Chromium 播放共同确认。

公开预览只引用已发布资产。插件保存案例时仍从原始审核 ZIP 提取媒体，在线预览不能替代私人库的完整性校验。

## 原因

- GitHub Releases 适合大文件和 Range 播放，不占用 GitHub Pages 的站点体积与软带宽额度。
- 内容哈希文件名、资产摘要和不可变发布共同提供稳定的审核边界。
- 不依赖来源站 CDN，避免删链、替换内容和热链策略变化。
- 不需要自建服务器、账号系统或用户遥测。

## 未采用

- 来源 CDN：成本低，但内容和可用性不受 PromptDirector 控制。
- GitHub Pages 直接存视频：会快速扩大站点与仓库，并消耗 Pages 带宽。
- 播放前下载整个 ZIP：安全但首播需要下载数十到上百 MiB，无法提供悬停预览。

## 发布门槛

先发布最小视频包，真实验证免登录访问、`video/mp4`、Range 请求和拖动播放。试点未通过时，不更新任何公开预览；通过后再逐包发布其余媒体。
