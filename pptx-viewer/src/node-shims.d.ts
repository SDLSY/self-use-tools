declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}

interface Buffer extends Uint8Array {
  toString(encoding?: string): string
  subarray(start?: number, end?: number): Buffer
}

declare const Buffer: {
  from(input: string, encoding?: string): Buffer
  concat(list: readonly Uint8Array[]): Buffer
}

declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { windowsHide?: boolean; timeout?: number; maxBuffer?: number },
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
  ): unknown
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array | string): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readdirSync(path: string): string[]
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function readFileSync(path: string): Buffer
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function statSync(path: string): { size: number }
  export function writeFileSync(path: string, data: Uint8Array | string): void
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function basename(p: string): string
  export function extname(p: string): string
  export function join(...paths: string[]): string
}
