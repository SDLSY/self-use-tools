# AGENTS.md — `self_use_tools` 协作与工程规范

本仓库是个人本地开发与桌面效率工具集（Windows 为主，部分工具联动 Linux VPS）。所有人类与 AI Agent（Claude Code / Codex / Orca 等）在本仓库工作时遵循本文件；完整背景参考 [`docs/large-repo-engineering-rules.md`](docs/large-repo-engineering-rules.md)，新建本地/VPS 项目的可复用模板见 [`docs/templates/`](docs/templates/README.md)。

---

## 1. 仓库结构与技术栈

| 目录 | 类型 | 技术栈 | 核心入口 |
|---|---|---|---|
| `agent-cache-panel/` | Orca 插件 | TypeScript + 原生 ES Module HTML/CSS | `src/worker.ts`、`panel/main.js` |
| `gemini-quota-panel/` | Orca 插件 | TypeScript + 原生 ES Module HTML/CSS | `src/worker.ts`、`panel/main.js` |
| `pptx-viewer/` | Orca 插件 | TypeScript + DrawingML/LibreOffice | `src/worker.ts`、`editor/app.js` |
| `md-viewer/` | 桌面应用（墨阅） | Electron + Vite + TypeScript | `electron/main.ts`、`src/main.ts` |
| `monitor-brightness/` | Windows 托盘工具 | C# (.NET Framework 4.x / DDC-CI) | `src/Program.cs`、`src/MonitorControl.cs` |
| `gemini-clean-env/` | Windows 隔离启动器 | PowerShell + CMD | `launch-*.ps1`、`check-env.ps1` |
| `docs/` | 工程规范与模板 | Markdown / 配置模板 | `large-repo-engineering-rules.md`、`templates/` |
| `scripts/` / `.githooks/` | 仓库级门禁 | Node.js / POSIX sh | `scripts/check-max-lines-ratchet.mjs`、`.githooks/pre-commit` |

---

## 2. 隐私与安全红线（最高优先级）

- **严禁触碰私有与运行态目录**：不得读取、扫描、修改、复制内容或提交 `.gitignore` 排除的目录与文件，包括但不限于：
  - `.secrets/`、`VPS资源/`、`cpa-quota/`、`worktrees/`、`.worktrees/`
  - `gemini-clean-env/chrome-profile/`、`gemini-clean-env/antigravity-data*/`、`gemini-clean-env/antigravity-extensions/`
- **严禁泄露敏感信息**：不得将真实 API Key、Token、Cookie、公网 IP、服务器密码、私有主机配置写入任何被 Git 追踪的源码、文档、示例或提交信息。
- **Git 安全底线**：
  - 未经用户明确指令，不得执行 `git commit`、`git push`、`git reset --hard` 或修改他人/已有未提交改动；
  - 禁止使用 `--no-verify` 绕过 Git 钩子或门禁检查。

---

## 3. 仓库与子项目验证命令（改动后必跑）

每次修改对应子项目后，执行最小必要验证并如实回报结果：

- **仓库级行数与隐私门禁**
  ```powershell
  node scripts/check-max-lines-ratchet.mjs          # 全量检查（当前全仓库 0 存量豁免）
  node scripts/check-max-lines-ratchet.mjs --changed # 仅检查本次改动文件
  # 如未启用仓库本地 pre-commit 钩子，可执行一次：
  git config core.hooksPath .githooks
  ```
- **Orca 插件（`agent-cache-panel` / `gemini-quota-panel` / `pptx-viewer`）**
  ```powershell
  orca plugin check .\<plugin-dir>
  orca plugin validate .\<plugin-dir>
  # 需要界面实测时加载/重载开发版：
  orca plugin dev reload .\<plugin-dir>
  ```
- **墨阅（`md-viewer`）**
  ```powershell
  cd md-viewer
  npm run build          # tsc (src + electron) + vite build + licenses + stage
  npm test               # 主流程验证
  npm run test:editor    # 编辑器相关改动时加跑
  ```
- **显示器亮度（`monitor-brightness`）**
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\monitor-brightness\build.ps1
  # 硬件冒烟测试（需先从托盘退出 MonitorBrightness）：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\monitor-brightness\tests\run-smoke.ps1
  ```
- **环境隔离脚本（`gemini-clean-env`）**
  ```powershell
  # 静态语法校验（不启动浏览器或触发网络）
  powershell -NoProfile -Command '$e=$null; Get-ChildItem .\gemini-clean-env\*.ps1 | ForEach-Object { [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$e); if($e){ throw "$($_.Name): $e" } }; "PS1 syntax OK"'
  ```

---

## 4. 编码与模块化红线

### 单文件有效行数约束（不含空行与注释）

| 文件类型 | 上限（有效行） | 说明 |
|---|---:|---|
| `.ts` / `.mts` / `.cts` / `.js` | **300** | 逻辑与 UI 渲染模块按领域拆分，杜绝上帝文件 |
| `.tsx` / `.jsx` | **400** | 给 JSX 模板留出空间 |
| `.ps1` / `.sh` / `.cs` | **400** | 脚本与轻量桌面源码 |
| `.py` | **450** | 同步控制函数圈复杂度（Ruff `C901 ≤ 15`） |
| `.mjs` / `.cjs`（构建/运维脚本） | **600** | 工程脚本适度放宽 |
| `*.test.*` / `*.spec.*` | **800** | 防止测试文件无节制膨胀 |

- **新建文件严格遵守上限**，禁止通过 `eslint-disable` / `oxlint-disable` / `biome-ignore` 绕过。
- **存量超标文件遵循棘轮原则（只减不增）**：禁止把新功能继续往 500~1500 行存量文件里堆；新增独立能力优先拆出新模块（Orca 面板已使用 `<script type="module">`，原生支持 ES Module 拆分）。

### 通用编码纪律

- **禁止垃圾桶命名**：不得新建 `utils`、`helpers`、`common`、`misc`、`shared-stuff` 文件或目录；按领域职责命名（如 `claude-transcript-parser.ts`、`quota-bucket-format.js`）。
- **复用优先于重造**：新增逻辑前先检查同子项目已有实现，避免并行维护两套相似代码。
- **极简注释原则**：注释只写 **Why**（隐藏约束、协议怪癖、平台差异），不复述 **How**，尽量一行写完。
- **跨平台 / 跨环境意识**：路径用 `path.join` / `Join-Path` / `pathlib.Path`；Web/Panel 代码不假设安全上下文专属 API（如非 HTTPS 下的 `crypto.randomUUID`）。
- **最小 Diff 原则**：`md-viewer/` 现有源码采用极简紧凑格式；在未统一引入格式化器前，修改存量文件保持局部最小 diff，不无故重排整文件。

### 语言专项红线

- **TypeScript**：优先用 `type` 定义类型；禁止新增显式 `any`、`@ts-ignore`、`@ts-nocheck`（极少数必要情形用 `@ts-expect-error` 并附原因）；纯类型用 `import type`；项目自有类型放 `.ts`（`.d.ts` 仅用于外部环境/模块垫片）；控制流强制 `{}`，优先提前 `return` 减少嵌套；联合类型 `switch` 做穷尽检查。
- **PowerShell**：脚本开头设 `$ErrorActionPreference = 'Stop'`；文件操作优先 `-LiteralPath` 与 `Join-Path`；不裸吞异常。
- **Python（联动或新建工具）**：用 `uv` 管理依赖与锁文件，`ruff check` + `ruff format` 统一校验；禁止裸 `except Exception: pass`；重试逻辑保留原始异常（`reraise=True`）；启动期 fail-fast 校验环境变量与配置。

---

## 5. 高信噪比测试红线

只在**同时满足 4 条原则**时写测试，杜绝 AI 堆砌“重构一碰就碎”的低价值测试：

1. **可失败性**：回滚本次业务改动，测试必须变红；
2. **预期值硬编码**：绝不用生产代码或公共常量动态计算断言预期；
3. **单一最便宜层级**：在拥有该行为的最便宜层级测一次，不跨层重复测同一契约；
4. **体量成比例**：小改动配精准用例，用参数化覆盖分支，不做无意义笛卡尔积。

**明确禁止**：测试界面文案/CSS 类名/常量默认值/第三方库行为/私有字段；只验证 Mock 调用的空转测试；单测中使用真实 `sleep`、真实外网请求或墙钟耗时断言；向生产代码添加 `*ForTests()` 导出或测试专用分支。
