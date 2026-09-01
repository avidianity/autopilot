import type { ProcessPort, ProcessResult } from "./types.js"

export class FakeProcessPort implements ProcessPort {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = []

  constructor(private readonly exitCodes: Record<string, number> = {}) {}

  setExit(command: string, code: number): void {
    this.exitCodes[command] = code
  }

  async run(input: {
    command: string
    args: string[]
    cwd: string
    timeoutMs: number
  }): Promise<ProcessResult> {
    this.calls.push({ command: input.command, args: input.args, cwd: input.cwd })
    const key = [input.command, ...input.args].join(" ")
    const code = this.exitCodes[key] ?? this.exitCodes[input.command] ?? 0
    return {
      code,
      stdout: code === 0 ? "ok" : "failed",
      stderr: code === 0 ? "" : "error",
    }
  }
}

export class BunProcessPort implements ProcessPort {
  async run(input: {
    command: string
    args: string[]
    cwd: string
    timeoutMs: number
  }): Promise<ProcessResult> {
    const subprocess = Bun.spawn([input.command, ...input.args], {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => subprocess.kill(), input.timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ])
      return { code: code ?? 1, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  }
}

export class ConstrainedProcessPort implements ProcessPort {
  constructor(private readonly inner: ProcessPort, private readonly allow: Set<string>) {}

  async run(input: {
    command: string
    args: string[]
    cwd: string
    timeoutMs: number
  }): Promise<ProcessResult> {
    if (!this.allow.has(input.command)) {
      throw new Error(`verification command not allowed: ${input.command}`)
    }
    return this.inner.run(input)
  }
}
