import { describe, expect, test } from "bun:test"

import AutopilotPlugin, { AutopilotPlugin as namedPlugin } from "../src/index.js"

describe("Autopilot plugin export", () => {
  test("provides one OpenCode plugin function", () => {
    expect(AutopilotPlugin).toBeFunction()
    expect(namedPlugin).toBe(AutopilotPlugin)
  })
})
