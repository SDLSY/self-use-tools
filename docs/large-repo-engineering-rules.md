# 大型开源仓库工程规范参考（以 `stablyai/orca` 为蓝本，附 Python/VPS 适配）

> 来源：提炼自 `stablyai/orca`（TypeScript / Electron / React / Node / Mobile 超大型开源仓库）的真实工程配置（`.oxlintrc.json`、`AGENTS.md`、`package.json`、`config/scripts/static-analysis/`、`docs/agents-md-refs/test-antipatterns.md`、`.github/CONTRIBUTING.md`），并补充面向 Python / VPS 工具链（参考 `HKUDS/LightRAG`）的对应落地方式，供 `self_use_tools` 及后续个人本地/VPS 项目按需裁剪引入。

---

## 核心哲学

大型开源仓库维持长期代码质量的关键，不是写一份厚重的口头《开发规范》，而是：

1. **把规范变成机器强约束**：用极速 Linter、AST 扫描和 CI 门禁代替人眼审查；
2. **同时约束人类与 AI Agent**：把唯一门禁命令、命名禁区、测试红线、踩坑边界直接写进根目录 `AGENTS.md` / `CLAUDE.md`；
3. **存量渐进治理（Ratchet 棘轮）**：历史老代码放进白名单基线，新代码和任何绕过注释一律拦截，技术债只减不增。

---

## 一、单文件行数硬上限 +「棘轮（Ratchet）」机制

### 1. 文件有效行数上限（不含空行和注释）

Orca 在 `.oxlintrc.json` 中通过 `max-lines`（`skipBlankLines: true, skipComments: true`）按文件类型分级卡死：

| 文件类型 | 上限（有效行） | 目的 |
|---|---:|---|
| `.ts` / `.mts` / `.cts` | **300 行** | 强制业务逻辑按职责拆分，杜绝上帝文件 |
| `.tsx` | **400 行** | 给 JSX 模板多留 100 行空间，同时防止巨型组件 |
| `.mjs`（工程/构建脚本） | **600 行** | 脚本类适度放宽 |
| `*.test.ts` / `*.spec.ts` | **800 行** | 防止测试文件无节制膨胀 |
| Python 模块（适配建议） | **400~500 行** | 配合 Ruff `C901` 圈复杂度上限（建议 ≤ 12~15） |

### 2. 棘轮（Ratchet）防绕过机制

在存量项目直接开启 `max-lines` 会一次性爆红，Orca 的解法是配一个轻量脚本（参考 `check-max-lines-ratchet.mjs`）：

- 维护一份 `max-lines-baseline.txt`，仅记录当前**存量允许超标或豁免的文件列表**；
- 校验规则：**只允许基线缩小，禁止新增条目**；
- 任何人在新文件里写 `// eslint-disable max-lines` / `// oxlint-disable max-lines` 试图绕过限制，门禁直接失败，逼迫其拆分模块；
- 老文件被拆小达标后，跑 `--prune` 自动移出基线。
- 同理可用于 `@ts-nocheck`、`any`、`# type: ignore`、不稳定测试写法、主线程同步阻塞调用等任何技术债指标。

---

## 二、用静态分析锁死「架构边界」与「历史踩坑」

不靠口头提醒，而是每踩一次严重坑就沉淀成一条机器规则：

1. **分层依赖隔离（`no-restricted-imports`）**：
   - 例如核心后端目录禁止 `import electron`，逼迫通过 typed bridge 解耦，使核心逻辑可同时运行在桌面与远程 Node/VPS 环境；
   - 生产代码禁止引入 `*.fixture.ts` 或测试 harness。
2. **冷启动/打包性能防回退**：
   - 重型 SDK 禁止顶层 value-import，仅允许 `import type` + 显式懒加载函数。
3. **跨环境安全 API 约束（`no-restricted-properties`）**：
   - 例如 Web/Shared 代码禁止直接调用 `crypto.randomUUID`（局域网明文 HTTP 非安全上下文不存在会白屏），强制走统一封装函数。
4. **零循环依赖**：开启 `import/no-cycle`（忽略纯类型依赖）。
5. **死代码清扫**：
   - TS/JS：定期或 CI 运行 `knip` 清理未使用文件、导出与依赖；
   - Python：Ruff `F401`/`F841` + `vulture`。
6. **AST 结构规则（`ast-grep`）**：
   - Linter 无法表达的复杂反模式（如裸吞异常、脆弱测试、特定资源泄漏写法）用 `ast-grep` 规则扫描，并给规则本身配单元测试。

---

## 三、编码风格与强类型红线

### 1. 通用编码纪律（适合直接写进 `AGENTS.md`）

- **禁用垃圾桶命名**：禁止新建名为 `utils`、`helpers`、`common`、`misc`、`shared-stuff` 的文件或目录，必须按具体领域概念命名（如 `quota-bucket-parser.ts`、`cpa-tunnel-health.ps1`）。若不得不叫 `helpers`，通常说明职责过多、应该拆分。
- **复用优先于重造**：新增逻辑前先检查现有模块能否扩展或泛化，禁止并行造两套相似实现。
- **极简注释原则**：注释只解释 **Why（为什么这么做/隐藏约束）**，不复述 **How（代码本身在干什么）**，尽量 1 行写完。
- **跨平台 / 远程一等公民**：路径统一用 `path.join` / `pathlib.Path`，快捷键/Shell/权限/环境变量差异用显式运行时守卫，不假设只在单一本地环境运行。

### 2. TypeScript / React 硬规则（`.oxlintrc.json`）

- 类型定义统一使用 `type`（`consistent-type-definitions: ["error", "type"]`）；
- 禁止显式 `any`（`no-explicit-any`）；
- 强制纯类型导入 `import type`（`consistent-type-imports`）；
- 强制 `switch` 穷尽检查（`switch-exhaustiveness-check`，禁止用 `default` 掩盖漏处理的联合分支）；
- 强制 `@ts-expect-error` 替代 `@ts-ignore`；
- 项目自有类型放 `.ts` 不放 `.d.ts`（避免 `skipLibCheck: true` 掩盖断链类型静默退化为 `any`）；
- 强制 `curly`（所有控制流带花括号）、`no-else-return`（提前 return 降低嵌套）；
- React 性能红线：禁止 render 中 `setState`、禁止在 `useEffect` 里派生状态、禁止 JSX 内联构造 Context 对象、禁止循环内 `...acc` 累加（防 $O(n^2)$）。

### 3. Python 对应硬规则（参考 `LightRAG`）

- 统一使用 `uv` 管理依赖与锁文件，`ruff check` + `ruff format` 替代 flake8/black/isort；
- 禁止裸 `except Exception: pass` 静默吞错误；
- 重试装饰器（如 `tenacity.retry`）明确 `reraise=True`，保留底层异常与错误信息；
- 启动期 fail-fast 校验并规范化环境变量与配置项，不把拼写错误留到运行时静默失效。

---

## 四、高信噪比「测试质量观」

重点防止 AI 协作时堆砌“数量多、没保护力、重构一碰就碎”的低价值测试：

### 必须同时满足 4 条原则才写测试
1. **可失败性**：把你的业务改动回滚，该测试必须变红（写完先破坏受保护的那一行验证一次）；
2. **预期值硬编码**：绝不用生产代码、常量或翻译表动态计算预期值；
3. **单一最便宜层级**：在拥有该行为的最便宜层级测一次，不在多层重复测同一契约；
4. **体量成比例**：1 行改动约配 1 个精准用例，用参数化覆盖不同分支，不做无意义的笛卡尔积组合。

### 明确禁止的测试反模式
- 禁止测试文案/翻译字符串、CSS/Tailwind 类名、常量默认值、第三方库自身行为、私有字段；
- 禁止只断言 Mock 调用或 Mock 自产自销数据的“空转测试”；
- 禁止用真实 `sleep` / 真实网络 / 墙钟耗时（wall-clock timing）写单测，必须用假时钟或事件同步；
- 禁止为测试污染生产代码（如 `*ForTests()` 导出、测试专用分支）；
- 性能回归测试单独隔离（如 `*.performance.test.ts`），只统计确定性工作量（消息数、渲染次数、调用次数），不测墙钟毫秒数。

---

## 五、工作流与门禁工程化

- **极速工具链**：TS/JS 优先用 Rust 工具链（`oxlint` + `oxfmt` 或 `biome`），Python 用 `ruff` + `uv`，保证检查在秒级完成；
- **单一增量门禁命令**：提供类似 `check:changed` 的一键命令，只检查本次改动及受影响范围，并在 `AGENTS.md` 中指明“改完跑一次即可，禁止 `--no-verify`”；
- **Git 提交前钩子**：JS 用 `husky + lint-staged`，Python 用 `pre-commit`；
- **隐私与安全门禁**：`.secrets/`、运行态 profile、密钥与资产清单严格 `.gitignore` 隔离，禁止误提交到远端仓库。

---

## 六、面向个人本地 + VPS 项目的分阶段引入清单

| 阶段 | 落地项 | 适用范围 | 成本 |
|---|---|---|---|
| **P0（立即可用）** | 根目录统一 `AGENTS.md`（命名禁区、极简注释、测试红线、隐私红线、本地验证命令） | 所有本地 & VPS 项目 | 15 分钟 |
| **P0（立即可用）** | TS 项目配 `oxlint` + `oxfmt`（含 `max-lines` 300/400/800）；Python 项目配 `ruff` + `pre-commit`；PS1/Shell 配 `PSScriptAnalyzer` / `shellcheck` | 新建及核心工具 | 30 分钟 |
| **P1（存量治理）** | 通用轻量 **Ratchet 行数棘轮脚本**（支持 `.ts`/`.tsx`/`.py`/`.ps1`/`.sh`，生成 `baseline.txt` 只减不增） | `self_use_tools` 及存量工具 | 1 小时 |
| **P1（防误提交）** | Git `pre-commit` 钩子：格式/Lint + 敏感信息/密钥扫描 + 行数棘轮 | 所有 Git 仓库 | 30 分钟 |
| **P2（按需扩展）** | 增量检查脚本 `check:changed` + 针对高频踩坑的 `ast-grep` / `no-restricted-imports` 规则 | 中大型工具 / 长期演进项目 | 按需 |
