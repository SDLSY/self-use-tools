# 个人本地 + VPS 项目工程规范模板集

本目录将 [`../large-repo-engineering-rules.md`](../large-repo-engineering-rules.md) 精炼为可直接复制落地的轻量模板，面向**个人高频 AI 协作（Claude Code / Codex / Orca）+ 本地 Windows / Linux VPS 多技术栈开发**。

## 模板清单

| 模板文件 | 适用场景 | 一句话用法 |
|---|---|---|
| [`AGENTS.template.md`](./AGENTS.template.md) | 任意新建本地 / VPS 项目 | 复制到新仓库根目录并重命名为 `AGENTS.md`，填写项目信息与验证命令 |
| [`oxlintrc.template.json`](./oxlintrc.template.json) | TypeScript / React / Node / Orca 插件 | 复制为 `.oxlintrc.json`，配 `npx oxlint` 或全局 `oxlint` 秒级检查 |
| [`pyproject-python-vps.template.toml`](./pyproject-python-vps.template.toml) | 本地 / VPS Python 服务、CLI、爬虫、自动化脚本 | 复制为 `pyproject.toml`，配合 `uv` + `uvx ruff` + `pytest` |
| [`check-max-lines-ratchet.template.mjs`](./check-max-lines-ratchet.template.mjs) | 任意存量 / 混合语言仓库（TS/JS/Py/PS1/Sh/C#） | 零依赖 Node 脚本，为存量超标文件建立只减不增的行数棘轮基线 |

---

## 3 分钟接入新项目指南

### 1. Python / VPS 工具（推荐 `uv` + `ruff`）

```bash
# 在本地或 VPS 新项目目录执行
uv init
# 复制 pyproject-python-vps.template.toml -> pyproject.toml（按需合并依赖）
# 复制 AGENTS.template.md -> AGENTS.md

# 日常一键门禁（无需全局安装 ruff）
uvx ruff check .
uvx ruff format --check .
uv run pytest
```

### 2. TypeScript / Node / Electron / Orca 插件

```bash
# 复制 oxlintrc.template.json -> .oxlintrc.json
# 复制 AGENTS.template.md -> AGENTS.md

# 若使用 oxlint（规则最贴近大型 TS 仓库，含 max-lines）：
npx --yes oxlint -c .oxlintrc.json .

# 若本机已装全局 biome，也可直接快速格式化/基础 lint：
biome check .
```

> **关于 `oxlint` 与 `biome` 的分工**：本机已预装全局 `biome`，但 `biome` 原生不包含 `max-lines` 规则；`oxlint`（Rust 实现，同样毫秒级）原生支持 `max-lines`、`consistent-type-definitions`、`import/no-cycle` 等完整规则集。两者可按项目二选一，或用 `check-max-lines-ratchet` 脚本跨语言统一管行数。

### 3. 存量仓库接入行数棘轮（Ratchet）

```bash
# 1. 复制脚本到项目 scripts/check-max-lines-ratchet.mjs
# 2. 首次生成存量基线（只扫描 git ls-files，自动跳过 .gitignore 隐私目录）
node scripts/check-max-lines-ratchet.mjs --init

# 3. 日常全量或仅检查改动文件
node scripts/check-max-lines-ratchet.mjs
node scripts/check-max-lines-ratchet.mjs --changed

# 4. 拆分老文件变小后，自动收紧并剔除已达标条目
node scripts/check-max-lines-ratchet.mjs --prune
```

### 4. Claude Code / Codex 共用 `AGENTS.md`

- Codex / Orca 原生读取根目录 `AGENTS.md`；
- 如希望 Claude Code 也自动加载同一份规则而不重复维护，可在项目根目录加一个单行 `CLAUDE.md`：
  ```markdown
  @AGENTS.md
  ```
