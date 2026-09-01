import { describe, expect, test } from "bun:test"

import AutopilotPlugin, { AutopilotPlugin as namedPlugin } from "../src/index.js"
import { confinePath } from "../src/sources/markdown.js"

describe("Autopilot plugin export", () => {
  test("provides one OpenCode plugin function", () => {
    expect(AutopilotPlugin).toBeFunction()
    expect(namedPlugin).toBe(AutopilotPlugin)
  })

  test("registers the autopilot command on config", async () => {
    const plugin = await AutopilotPlugin({
      client: { session: {} },
      directory: "/repo",
    } as never)
    const cfg: { command?: Record<string, { template: string }> } = {}
    await plugin.config?.(cfg as never)
    expect(cfg.command?.autopilot?.template).toContain("$ARGUMENTS")
  })

  test("routes session.error through the Supervisor hook", async () => {
    const plugin = await AutopilotPlugin({
      client: { session: {} },
      directory: "/repo-error-hook",
    } as never)
    await plugin.event?.({
      event: { type: "session.error", properties: { sessionID: "ses_1" } },
    } as never)
  })
})

describe("path confinement", () => {
  test("rejects parent-directory segments", () => {
    expect(() => confinePath("/repo", "../secret")).toThrow("project root")
  })
})
