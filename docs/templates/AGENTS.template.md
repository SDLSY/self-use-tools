# AGENTS.md — `<项目名称>`

> 一句话说明本项目做什么、运行在哪里（本机 Windows / Linux VPS / 容器）。

## 1. 目录与核心入口

- `<src/>`：核心业务逻辑（入口：`<main file>`）
- `<scripts/>`：构建 / 部署 / 运维脚本
- `<tests/>`：自动化测试

## 2. 隐私、密钥与 VPS 安全红线

- **绝不提交敏感文件**：`.env`、`.secrets/`、私钥、Cookie、导出配置、真实服务器 IP/凭证必须保留在 `.gitignore` 中，严禁写入源码、日志样例或 commit message。
- **VPS / 生产环境操作纪律**（如适用）：
  - 修改 `systemd`、`nginx`、`caddy`、防火墙、crontab、数据库结构或重启线上服务前，必须先说明变更内容并获得确认；
  - 变更配置前先备份或使用 `nginx -t` / `caddy validate` 等干跑校验；
  - 所有远程脚本默认幂等、失败即止（Bash 用 `set -euo pipefail`，PowerShell 用 `$ErrorActionPreference = 'Stop'`）。
- **Git 底线**：未经明确指令不执行 `git commit` / `git push`；禁止 `--no-verify`。

## 3. 唯一验证命令（改完即跑）

```bash
# 按项目实际替换为 1~3 条秒级命令，例如：
# Python: uvx ruff check . && uvx ruff format --check . && uv run pytest
# TS/Node: npx oxlint . && npm run typecheck && npm test
# Shell/PS1: shellcheck scripts/*.sh
```

## 4. 编码与结构红线

- **单文件有效行数上限**（不含空行和注释）：
  - `.ts`/`.js` ≤ 300 | `.tsx` ≤ 400 | `.py` ≤ 450 | `.sh`/`.ps1` ≤ 400 | 脚本 `.mjs` ≤ 600 | 测试 ≤ 800
  - 禁止写 `eslint-disable` / `oxlint-disable` / `# noqa` 绕过体积或质量门禁；存量超标文件遵循“只减不增”。
- **禁止垃圾桶命名**：不新建 `utils`、`helpers`、`common`、`misc`，按领域职责命名。
- **复用优先**：新增前先看现有模块能否扩展，避免双份实现。
- **极简注释**：只解释 **Why**（隐藏约束/协议怪癖/线上坑），不复述 **How**，尽量一行。
- **失败显式暴露**：
  - Python 禁止裸 `except Exception: pass`；重试（如 `tenacity`）必须 `reraise=True`；启动期 fail-fast 校验环境变量；
  - TS 禁止新增显式 `any`、`@ts-ignore`、`@ts-nocheck`，优先 `type` 与 `import type`。
- **跨环境兼容**：路径用 `path.join` / `pathlib.Path` / `Join-Path`，不硬编码单机绝对路径。

## 5. 测试质量红线

- 满足 4 原则才写测试：**可失败性**（回滚改动必红）、**预期值硬编码**、**单一最便宜层级**、**体量成比例**。
- 禁止测文案/样式类名/常量默认值/第三方库行为；禁止真实 `sleep`、真实外网或墙钟耗时断言；禁止污染生产代码（`*ForTests`）。
