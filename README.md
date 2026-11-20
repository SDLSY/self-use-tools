# self-use-tools

个人日常开发与桌面效率工具集，包含 [Orca](https://orca.dev) 扩展插件、Windows 桌面实用工具以及环境隔离脚本。

## 工具一览

| 目录 | 类型 | 技术栈 | 简介 |
| --- | --- | --- | --- |
| [`agent-cache-panel/`](./agent-cache-panel) | Orca 插件 | TypeScript / HTML / CSS | 实时监控 Claude Code / Codex / OpenCode / Pi / AGY 的 Prompt Cache 命中率、逐轮趋势柱状图、Token 构成与大额未命中告警 |
| [`pptx-viewer/`](./pptx-viewer) | Orca 插件 | TypeScript / DrawingML / LibreOffice | 在 Orca 标签页内双引擎混合渲染浏览 `.pptx` / `.ppt`（浏览器即时预览 + LibreOffice/Poppler 高清渲染、胶片缩略图、全屏与演讲备注） |
| [`gemini-quota-panel/`](./gemini-quota-panel) | Orca 插件 | TypeScript / HTML / CSS | 展示 Antigravity / Gemini 多账号共享池额度、5h / Weekly 双桶倒计时、能力标签与状态栏预警 |
| [`md-viewer/`](./md-viewer) | Windows 桌面应用 | Electron / TypeScript / KaTeX / Mermaid | **墨阅**——中文界面、单窗口多标签、支持编辑/分栏/实时预览、LaTeX 公式与 Mermaid 图表的本地 Markdown 查看器 |
| [`monitor-brightness/`](./monitor-brightness) | Windows 托盘工具 | C# / .NET Framework 4.x / DDC-CI | 免安装多显示器硬件亮度调节托盘工具，无需第三方运行库或管理员权限，自带回读核验 |
| [`gemini-clean-env/`](./gemini-clean-env) | Windows 隔离脚本 | PowerShell | Chrome 与 Antigravity 的独立数据目录 + 代理门禁启动脚本，支持出口环境自检 |

## 快速上手

### Orca 插件（`agent-cache-panel` / `pptx-viewer` / `gemini-quota-panel`）

```powershell
# 校验插件 manifest
orca plugin validate .\agent-cache-panel

# 加载开发插件
orca plugin dev load .\agent-cache-panel
```

### Windows 桌面工具

- **墨阅 (`md-viewer`)**：进入 `md-viewer/` 安装依赖并按 `md-viewer/README.md` 构建或运行。
- **显示器亮度 (`monitor-brightness`)**：在 `monitor-brightness/` 下运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1` 即可调用系统自带 .NET 编译器生成 `MonitorBrightness.exe`。

## 隐私与安全约定

- 所有本机运行时数据、密钥、服务器资产清单及个人运维脚本（如 `.secrets/`、`chrome-profile/` 等）均已通过 `.gitignore` 排除在版本库之外。
- 详细配置与使用方法见各子目录下的 `README.md`。
