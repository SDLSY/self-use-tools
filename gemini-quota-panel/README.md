# Gemini Quota

在 Orca 中查看 CPA（CLIProxyAPI）反代的 Antigravity / Gemini Pro 账号剩余额度。

- **右侧栏面板**：`panel/index.html`，展示多账号共享池概览（`Gemini 共享池` / `Claude / GPT 池`）、带状态点与剩余百分比的账号筛选 chips、账号模型能力标签（`Neon` / `Hydrogen` / `Argon` / `3.8 Flash` / `Claude 5.5`）、Antigravity 官方两桶额度（`Weekly limit` 与 `5h limit`，均带实时倒计时与悬停本地时间），以及默认折叠的逐模型明细抽屉。
- **跳过 / 过期账号**：以柔和卡片展示本地化过期时间与原因，不误报为故障，也不影响其它可用账号。
- **状态栏**：`Gemini 95.2%`（仅统计可用账号的 Gemini 模型平均剩余额度），按 `warnBelow` / `dangerBelow` 自动变色，悬停显示 Gemini 5h / 周平均与 Claude·GPT 摘要及可用账号数，点击直接打开面板，后台定时刷新。
- **数据源**：复用 `../cpa-quota/Get-CpaQuota.ps1 -Json`，通过 SSH 在 `tencent-vps` 上只读查询 Antigravity 的 `retrieveUserQuotaSummary` 与 `retrieveUserQuota`；token 仅留在远端，不落盘、不回传。

## 结构

```text
gemini-quota-panel/
├─ orca-plugin.json        # trusted-worker：面板 + 状态栏 + 设置
├─ src/
│  ├─ worker.ts            # 脚本调用、数据清洗、缓存、状态栏、定时刷新
│  └─ protocol.ts          # 面板 <-> worker 的类型契约
├─ panel/
│  ├─ index.html           # 面板入口
│  ├─ style.css            # Orca 深/浅色主题变量适配、卡片与圆环样式
│  └─ main.js              # 共享池汇总、账号筛选、实时倒计时、折叠明细
└─ assets/icon.png
```

## 开发 / 加载

```powershell
# 校验 manifest
orca plugin validate D:\self_use_tools\gemini-quota-panel

# 作为开发插件加载或热重载
orca plugin dev load D:\self_use_tools\gemini-quota-panel
orca plugin dev reload D:\self_use_tools\gemini-quota-panel

# 打开面板
orca plugin open local.gemini-quota-panel --panel gemini-quota

# 截取当前面板与状态栏
orca plugin shot local.gemini-quota-panel --panel gemini-quota --width 360 --out D:\self_use_tools\gemini-quota-panel\.orca\shots\panel-v2.png
orca plugin shot local.gemini-quota-panel --status-bar --out D:\self_use_tools\gemini-quota-panel\.orca\shots\status-bar-v2.png

# 卸载开发插件
orca plugin dev unload D:\self_use_tools\gemini-quota-panel
```

## 设置

Orca → Settings → Plugins → Gemini Quota：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `scriptPath` | `D:\self_use_tools\cpa-quota\Get-CpaQuota.ps1` | 额度脚本绝对路径 |
| `sshHost` | `tencent-vps` | 传给脚本的 SSH 主机别名 |
| `sshDir` | `D:\git\Git\usr\bin` | 包含 `ssh.exe` 的目录（默认使用 Git 自带 OpenSSH） |
| `refreshMinutes` | `5` | 后台自动刷新间隔（1–60 分钟） |
| `warnBelow` | `20` | 低于该百分比时状态栏与面板圆环变为警告色 |
| `dangerBelow` | `5` | 低于该百分比时状态栏与面板圆环变为危险色 |

## 数据流与容错

1. worker 启动后立即从已清洗的本地缓存渲染状态栏，同时按需后台刷新，并每 `refreshMinutes` 分钟定时拉取。
2. 所有脚本输出与历史缓存均经过 `sanitizeSnapshot()` 清洗（自动剔除 `null` / 非法项、限制百分比范围），再写入 `quota.snapshot` 并更新状态栏。
3. 任意刷新或渲染异常均有兜底处理，不会引发未捕获异常导致 worker 崩溃；若存在历史缓存则保留展示并在顶部提示。
