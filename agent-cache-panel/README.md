# Agent Cache

在 Orca 中实时查看当前工作区 Coding Agent（Claude Code / Codex / OpenCode / Pi / AGY）的 Prompt Cache 命中率、逐轮趋势与 Token 构成。

## 支持的 Agent

| Agent | 本地数据来源 | 缓存指标 |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/**/*.jsonl`（增量解析、按 `message.id` 去重） | 完整（逐轮 + 会话） |
| **Codex** | `~/.codex/sessions/**/*.jsonl`（超大文件自动尾读 + 增量解析） | 完整（逐轮 + 会话） |
| **OpenCode（v1 / v2）** | `~/.local/share/opencode/opencode.db`（只读 SQLite） | 完整（逐轮 + 会话） |
| **Pi** | `~/.pi/agent/sessions/**/*.jsonl`（增量解析） | 完整（逐轮 + 会话） |
| **AGY（Antigravity CLI）** | `~/.gemini/antigravity-cli/conversations/*.db`（只读 SQLite + Protobuf） | 本地库暂未写入 `cache_read` 字段，展示轮次与上下文估算并预留兼容 |

## 功能

- **底部状态栏**：实时显示 `Cache 95.8%`，按阈值自动切换绿/黄/红状态色，悬停显示会话累计 / 近 5 轮 / 最近 1 轮命中率与 Token 统计，点击直接打开右侧面板。
- **右侧栏面板**：
  - 双 KPI 卡片：`会话命中率` 与 `最近一轮`（附近 5 轮均值与新增 Token）
  - **逐轮命中趋势柱状图**：展示最近 28 轮 API 调用命中率，悬停任意柱条查看精确时间、模型、缓存读取/未缓存/输出明细
  - **输入 Token 构成**：分段占比条 + 缓存读取 / 未缓存输入 / 缓存写入 / 总输出四项指标
  - **大额缓存未命中告警**：自动统计单轮未缓存输入 ≥25K 且命中率 <20% 的异常击穿次数与重算量
  - **最近轮次明细抽屉**：默认折叠，展开查看最近 15 轮明细
- **纯本地增量解析**：通过 Orca 的 `agents.list` / `workspace.readContext` / 实时事件定位本地会话 JSONL，按字节偏移增量读取，超大长会话几乎零开销。

## 加载与调试

```powershell
orca plugin validate D:\self_use_tools\agent-cache-panel
orca plugin dev load D:\self_use_tools\agent-cache-panel
orca plugin open local.agent-cache-panel --panel agent-cache
```
