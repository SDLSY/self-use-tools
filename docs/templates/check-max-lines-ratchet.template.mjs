#!/usr/bin/env node
/**
 * 轻量跨语言 max-lines 棘轮（Ratchet）检查脚本（零第三方依赖）
 *
 * 原则：
 * 1. 只扫描 `git ls-files`（天然跳过 .gitignore 中的密钥/运行态目录）；
 * 2. 新建或未入基线的文件严格执行上限；
 * 3. 基线内的存量超标文件记录其当前有效行数上限，只允许持平或缩小，禁止膨胀；
 * 4. 拦截任何试图用注释绕过 max-lines 的写法。
 *
 * 用法：
 *   node check-max-lines-ratchet.mjs               # 全量校验
 *   node check-max-lines-ratchet.mjs --changed     # 仅校验本次改动/暂存文件
 *   node check-max-lines-ratchet.mjs --init        # 生成/重建基线文件
 *   node check-max-lines-ratchet.mjs --prune       # 自动收紧变小的基线并移除已达标文件
 *   node check-max-lines-ratchet.mjs --report      # 仅打印超标汇总（不修改文件，不报错）
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_PATH = path.resolve(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.resolve(process.cwd(), ".max-lines-baseline.txt");

// 按扩展名设置有效行数上限（不含空行与注释）
const LIMITS = {
  ".ts": 300,
  ".mts": 300,
  ".cts": 300,
  ".js": 300,
  ".tsx": 400,
  ".jsx": 400,
  ".py": 450,
  ".ps1": 400,
  ".sh": 400,
  ".cs": 400,
  ".mjs": 600,
  ".cjs": 600,
};
const TEST_FILE_LIMIT = 800;

const BYPASS_RE =
  /(?:\/\/|\/\*|#)\s*(?:(?:eslint|oxlint)-disable[^\n]*max-lines|biome-ignore[^\n]*max-lines|max-lines-ignore)\b/i;

function isTestFile(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return (
    /\.(test|spec)\.[^.]+$/i.test(norm) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(norm) ||
    /_test\.py$/i.test(norm)
  );
}

function getLimit(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (!(ext in LIMITS)) return null;
  return isTestFile(relPath) ? TEST_FILE_LIMIT : LIMITS[ext];
}

function countEffectiveLines(content, ext) {
  const lines = content.split(/\r?\n/);
  const isCStyle = [
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".cs",
  ].includes(ext);
  const isPS = ext === ".ps1";
  const isHash = ext === ".py" || ext === ".sh";

  let effective = 0;
  let inBlock = false;

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    if (isCStyle) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) continue;
        line = line.slice(end + 2).trim();
        inBlock = false;
        if (!line) continue;
      }
      while (line.startsWith("/*")) {
        const end = line.indexOf("*/", 2);
        if (end === -1) {
          inBlock = true;
          line = "";
          break;
        }
        line = line.slice(end + 2).trim();
      }
      if (!line || line.startsWith("//")) continue;
      effective++;
    } else if (isPS) {
      if (inBlock) {
        const end = line.indexOf("#>");
        if (end === -1) continue;
        line = line.slice(end + 2).trim();
        inBlock = false;
        if (!line) continue;
      }
      if (line.startsWith("<#")) {
        const end = line.indexOf("#>", 2);
        if (end === -1) {
          inBlock = true;
          continue;
        }
        line = line.slice(end + 2).trim();
        if (!line) continue;
      }
      if (line.startsWith("#")) continue;
      effective++;
    } else if (isHash) {
      if (line.startsWith("#")) continue;
      effective++;
    } else {
      effective++;
    }
  }
  return effective;
}

function runGitLines(cmd) {
  try {
    return execSync(`git -c core.quotepath=false ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listCandidateFiles(changedOnly) {
  const cmds = changedOnly
    ? [
        "diff --name-only --diff-filter=ACMR HEAD",
        "diff --cached --name-only --diff-filter=ACMR",
        "ls-files --others --exclude-standard",
      ]
    : ["ls-files --cached --others --exclude-standard"];
  const results = new Set();
  for (const cmd of cmds) {
    for (const file of runGitLines(cmd)) {
      results.add(file);
    }
  }
  return [...results];
}

function loadBaseline() {
  const map = new Map();
  if (!fs.existsSync(BASELINE_FILE)) return map;
  for (const raw of fs.readFileSync(BASELINE_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(.+?)\s+(\d+)$/.exec(line);
    if (!match) continue;
    map.set(match[1].replace(/\\/g, "/"), Number(match[2]));
  }
  return map;
}

function saveBaseline(entries) {
  const header = [
    "# max-lines 棘轮基线（格式：<相对路径> <当前有效行数上限>）",
    "# 只允许数值变小或条目移除，禁止手动增大上限或新增条目。",
    "",
  ];
  const sorted = [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const body = sorted.map(([file, lines]) => `${file} ${lines}`);
  fs.writeFileSync(BASELINE_FILE, [...header, ...body, ""].join("\n"), "utf8");
}

function main() {
  const args = new Set(process.argv.slice(2));
  const modeInit = args.has("--init");
  const modePrune = args.has("--prune");
  const modeReport = args.has("--report");
  const modeChanged = args.has("--changed");

  const files = listCandidateFiles(modeChanged && !modeInit && !modePrune);
  const baseline = loadBaseline();
  const measured = new Map();
  const violations = [];
  const bypasses = [];
  const overLimit = [];

  for (const rawFile of files) {
    const rel = rawFile.replace(/\\/g, "/");
    if (path.resolve(rel) === SELF_PATH) continue;
    const limit = getLimit(rel);
    if (limit === null || !fs.existsSync(rel)) continue;

    const content = fs.readFileSync(rel, "utf8");
    if (BYPASS_RE.test(content)) {
      bypasses.push(rel);
    }
    const eff = countEffectiveLines(content, path.extname(rel).toLowerCase());
    measured.set(rel, { eff, limit });

    if (eff > limit) {
      overLimit.push({ rel, eff, limit });
      const ceiling = baseline.get(rel);
      if (ceiling === undefined) {
        violations.push(`${rel}: ${eff} 有效行 > 上限 ${limit}（未在基线中，请拆分模块）`);
      } else if (eff > ceiling) {
        violations.push(`${rel}: ${eff} 有效行 > 基线冻结值 ${ceiling}（禁止存量继续膨胀）`);
      }
    }
  }

  if (modeReport) {
    overLimit.sort((a, b) => b.eff - a.eff);
    console.log(`扫描完成：共 ${measured.size} 个源码文件，超出默认上限 ${overLimit.length} 个`);
    for (const item of overLimit) {
      console.log(`  ${String(item.eff).padStart(5)} / ${item.limit}  ${item.rel}`);
    }
    return;
  }

  if (modeInit) {
    const next = new Map(overLimit.map((x) => [x.rel, x.eff]));
    saveBaseline(next);
    console.log(`已生成基线 ${path.basename(BASELINE_FILE)}（共 ${next.size} 个存量超标文件）`);
    return;
  }

  if (modePrune) {
    const next = new Map();
    let pruned = 0;
    let tightened = 0;
    for (const [file, oldCeiling] of baseline.entries()) {
      const stat = measured.get(file);
      if (!stat || stat.eff <= stat.limit) {
        pruned++;
        continue;
      }
      const nextCeiling = Math.min(oldCeiling, stat.eff);
      if (nextCeiling < oldCeiling) tightened++;
      next.set(file, nextCeiling);
    }
    saveBaseline(next);
    console.log(`基线已收紧：移除 ${pruned} 项，下调上限 ${tightened} 项，剩余 ${next.size} 项`);
    return;
  }

  if (bypasses.length > 0) {
    console.error("检测到禁止的 max-lines 绕过注释：");
    for (const f of bypasses) console.error(`  - ${f}`);
  }
  if (violations.length > 0) {
    console.error("max-lines 棘轮检查失败：");
    for (const v of violations) console.error(`  - ${v}`);
  }
  if (bypasses.length > 0 || violations.length > 0) {
    process.exit(1);
  }
  console.log(`max-lines 棘轮检查通过（扫描 ${measured.size} 个源码文件）`);
}

main();
