# Gemini / Antigravity 独立隔离环境

这个目录用于将指定的 Google 账号与日常使用的 Chrome、Antigravity 隔离开，避免登录态、Cookie、缓存和插件相互干扰。

## 目录结构

```text
gemini-clean-env/
├─ chrome-profile/          Chrome 独立配置（本地生成，已加入 .gitignore）
├─ antigravity-data/        Antigravity 独立用户数据（本地生成，已加入 .gitignore）
├─ antigravity-extensions/  Antigravity 独立插件目录（本地生成，已加入 .gitignore）
├─ launch-gemini.ps1        启动独立 Chrome（自动校验代理端口）
├─ launch-antigravity.ps1   启动独立 Antigravity（自动校验代理端口）
├─ check-env.ps1 / .cmd     检查可执行文件、目录及代理出口 IP
└─ README.md
```

## 使用前准备

1. 启动本地代理客户端（如 Clash Verge），确保混合代理端口与脚本中的 `$proxyPort` 一致（默认 `7688`）。
2. 如代理端口不同，修改 `launch-gemini.ps1`、`launch-antigravity.ps1` 与 `check-env.ps1` 中的 `$proxyPort` 即可。

脚本启动前会检测 `127.0.0.1:<proxyPort>`；若未检测到可用代理会弹窗提示并取消启动，避免直连登录。确需直连时可加 `-Direct` 参数：

```powershell
.\launch-gemini.ps1 -Direct
.\launch-antigravity.ps1 -Direct
```

## 环境检查

运行 `check-env.cmd`（或 `.\check-env.ps1`），检查 Chrome、Antigravity、本地隔离目录是否就绪，并查询当前代理出口 IP 与归属地。

## 注意事项

- 两个程序均仅读写本目录下的独立数据目录，不会影响系统默认的 Chrome 与 Antigravity 配置。
- `chrome-profile/` 和 `antigravity-data/` 包含登录 Cookie 与本地令牌，切勿分享或提交到代码仓库；如需备份请加密保存。
- 本方案为浏览器/进程数据目录级隔离，并非完整虚拟机隔离。

## 重置环境

完全关闭对应程序后删除本地数据目录即可，下次启动会自动重建：

- 重置 Chrome：删除 `chrome-profile/`
- 重置 Antigravity：删除 `antigravity-data/` 和 `antigravity-extensions/`
