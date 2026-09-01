export interface RunnerSession {
  id: string
  title: string
}

export interface SessionRunner {
  create(input: { title: string; workingDirectory?: string }): Promise<RunnerSession>
  prompt(sessionId: string, instruction: { command?: string; prompt?: string }): Promise<void>
  abort(sessionId: string): Promise<void>
  list(): Promise<RunnerSession[]>
}

export interface OpenCodeSessionClient {
  session: {
    create(body: { title: string }): Promise<{ data: { id: string; title: string } }>
    promptAsync(path: { id: string }, body: { parts: Array<{ type: "text"; text: string }> }): Promise<unknown>
    abort(id: { id: string }): Promise<unknown>
    list(): Promise<{ data: Array<{ id: string; title: string }> }>
  }
}

export class OpenCodeSessionRunner implements SessionRunner {
  constructor(private readonly client: OpenCodeSessionClient) {}

  async create(input: { title: string; workingDirectory?: string }): Promise<RunnerSession> {
    const created = await this.client.session.create({ title: input.title })
    return { id: created.data.id, title: created.data.title }
  }

  async prompt(sessionId: string, instruction: { command?: string; prompt?: string }): Promise<void> {
    const text = instruction.command ?? instruction.prompt ?? ""
    await this.client.session.promptAsync(
      { id: sessionId },
      { parts: [{ type: "text", text }] },
    )
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.session.abort({ id: sessionId })
  }

  async list(): Promise<RunnerSession[]> {
    const listed = await this.client.session.list()
    return listed.data.map((session) => ({ id: session.id, title: session.title }))
  }
}

export class FakeSessionRunner implements SessionRunner {
  readonly created: RunnerSession[] = []
  readonly prompted: Array<{ sessionId: string; instruction: { command?: string; prompt?: string } }> = []
  readonly aborted: string[] = []
  createCalls = 0
  onCreate?: () => void

  async create(input: { title: string; workingDirectory?: string }): Promise<RunnerSession> {
    this.createCalls += 1
    this.onCreate?.()
    const session = { id: `ses_${this.createCalls}`, title: input.title }
    this.created.push(session)
    return session
  }

  async prompt(sessionId: string, instruction: { command?: string; prompt?: string }): Promise<void> {
    this.prompted.push({ sessionId, instruction })
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId)
  }

  async list(): Promise<RunnerSession[]> {
    return [...this.created]
  }
}

export function encodeLaunchTitle(input: {
  runId: string
  workItemId: string
  launchToken: string
}): string {
  return `autopilot run=${input.runId} work=${input.workItemId} launch=${input.launchToken}`
}

export function decodeLaunchTitle(title: string): {
  runId: string
  workItemId: string
  launchToken: string
} | undefined {
  const match = /autopilot run=(\S+) work=(\S+) launch=(\S+)/.exec(title)
  const runId = match?.[1]
  const workItemId = match?.[2]
  const launchToken = match?.[3]
  if (!runId || !workItemId || !launchToken) {
    return undefined
  }
  return { runId, workItemId, launchToken }
}
