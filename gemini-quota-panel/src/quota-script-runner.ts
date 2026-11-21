import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { QuotaSnapshot } from './protocol'
import { asString, clamp, errorMessage, parseSnapshot } from './snapshot-sanitizer'

const DEFAULT_SCRIPT = 'D:\\self_use_tools\\cpa-quota\\Get-CpaQuota.ps1'
const DEFAULT_SSH_HOST = 'tencent-vps'
const DEFAULT_SSH_DIR = 'D:\\git\\Git\\usr\\bin'
const DEFAULT_REFRESH_MINUTES = 20
const WARN_BELOW = 20
const DANGER_BELOW = 5
const SCRIPT_TIMEOUT_MS = 120_000

export type Settings = {
  scriptPath: string
  sshHost: string
  sshDir: string
  refreshMinutes: number
  warnBelow: number
  dangerBelow: number
}

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

export async function readSettings(orca: OrcaWorkerApi): Promise<Settings> {
  try {
    const raw = ((await orca.settings.get()) || {}) as Record<string, unknown>
    return {
      scriptPath: asString(raw.scriptPath) ?? DEFAULT_SCRIPT,
      sshHost: asString(raw.sshHost) ?? DEFAULT_SSH_HOST,
      sshDir: asString(raw.sshDir) ?? DEFAULT_SSH_DIR,
      refreshMinutes: clamp(raw.refreshMinutes, DEFAULT_REFRESH_MINUTES, 1, 60),
      warnBelow: clamp(raw.warnBelow, WARN_BELOW, 0, 100),
      dangerBelow: clamp(raw.dangerBelow, DANGER_BELOW, 0, 100)
    }
  } catch (error) {
    orca.log(`settings read failed, using defaults: ${errorMessage(error)}`)
    return {
      scriptPath: DEFAULT_SCRIPT,
      sshHost: DEFAULT_SSH_HOST,
      sshDir: DEFAULT_SSH_DIR,
      refreshMinutes: DEFAULT_REFRESH_MINUTES,
      warnBelow: WARN_BELOW,
      dangerBelow: DANGER_BELOW
    }
  }
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
  envOverride?: Record<string, string | undefined>
): Promise<RunResult> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const pathEnv = [
    process.env.PATH || '',
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${systemRoot}\\System32\\OpenSSH`,
    `${systemRoot}\\System32`
  ]
    .filter(Boolean)
    .join(';')
  const env = envOverride ?? {
    ...process.env,
    PATH: pathEnv,
    HOME: process.env.HOME || homedir(),
    USERPROFILE: process.env.USERPROFILE || homedir()
  }
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env
      },
      (error, stdout, stderr) => {
        const output = String(stdout ?? '')
        const errors = String(stderr ?? '')
        if (error) {
          reject(Object.assign(error, { stdout: output, stderr: errors }))
          return
        }
        resolve({ stdout: output, stderr: errors, code: 0 })
      }
    )
  })
}

export async function runQuotaScript(settings: Settings): Promise<QuotaSnapshot> {
  const powershell =
    process.platform === 'win32' && process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : 'powershell.exe'
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    settings.scriptPath,
    '-Json'
  ]
  if (settings.sshHost) args.push('-SshHost', settings.sshHost)

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const pathEnv = [
    settings.sshDir,
    process.env.PATH || '',
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${systemRoot}\\System32\\OpenSSH`,
    `${systemRoot}\\System32`
  ]
    .filter(Boolean)
    .join(';')
  const env = {
    ...process.env,
    PATH: pathEnv,
    HOME: process.env.HOME || homedir(),
    USERPROFILE: process.env.USERPROFILE || homedir()
  }

  let result: RunResult
  try {
    result = await execFileAsync(powershell, args, SCRIPT_TIMEOUT_MS, env)
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number }
    if (failed.stdout) {
      try {
        const snapshot = parseSnapshot(failed.stdout)
        return {
          ...snapshot,
          exitCode: typeof failed.code === 'number' ? failed.code : 1
        }
      } catch {
        // Fall through to stderr/message below.
      }
    }
    const output = [failed.stderr, failed.stdout].filter(Boolean).join('\n').trim()
    throw new Error(output || failed.message || '额度脚本执行失败')
  }

  const snapshot = parseSnapshot(result.stdout)
  return { ...snapshot, exitCode: result.code }
}

function resolveOrcaCli(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND
  const execDir = dirname(process.execPath)
  const candidates = [
    join(execDir, 'resources', 'bin', 'orca.exe'),
    join(execDir, '..', 'resources', 'bin', 'orca.exe'),
    join(execDir, 'orca.exe'),
    'D:\\Apps\\Orca\\resources\\bin\\orca.exe'
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Try next candidate.
    }
  }
  return 'orca'
}

export function openQuotaPanel(orca: OrcaWorkerApi): Promise<boolean> {
  const profile = process.env.USERPROFILE || homedir()
  const env = {
    ...process.env,
    APPDATA: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    USERPROFILE: profile,
    HOME: process.env.HOME || homedir()
  }
  return new Promise((resolve) => {
    execFile(
      resolveOrcaCli(),
      ['plugin', 'open', 'local.gemini-quota-panel', '--panel', 'gemini-quota'],
      { windowsHide: true, timeout: 15_000, cwd: profile, env },
      (error, _stdout, stderr) => {
        if (error) {
          orca.log(
            `open panel failed: ${error.message}${stderr ? ` ${stderr}` : ''} (execPath=${
              process.execPath
            })`
          )
          resolve(false)
          return
        }
        resolve(true)
      }
    )
  })
}
