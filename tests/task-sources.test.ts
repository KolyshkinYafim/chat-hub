import { describe, expect, it } from "vitest"
import { availableTaskSources, buildTaskSourcePrompt, normalizeSessionOrigin, taskSourceOrigin } from "../src/shared/task-sources"
import type { McpServerDef } from "../src/shared/mcp"

const server = (id: string, enabled = true): McpServerDef => ({ id, name: id, enabled, transport: "http", args: [], envKeys: [] })

describe("task source selection", () => {
  it("offers a generic link without integrations, and only enabled source presets", () => {
    expect(availableTaskSources([])).toEqual(["url"])
    expect(availableTaskSources([server("clickup"), server("sentry", false), server("figma")])).toEqual(["clickup", "url"])
    expect(availableTaskSources([server("sentry"), server("clickup")])).toEqual(["clickup", "sentry", "url"])
  })
  it("normalizes task IDs and task links, including custom ClickUp IDs", () => {
    expect(taskSourceOrigin("clickup", " MY-123 ")).toEqual({ kind: "clickup", ref: "MY-123", url: "https://app.clickup.com/t/MY-123" })
    expect(taskSourceOrigin("clickup", "https://app.clickup.com/t/123/MY-123").ref).toBe("MY-123")
    expect(taskSourceOrigin("sentry", "https://org.sentry.io/issues/12345/?project=7").ref).toBe("12345")
    expect(taskSourceOrigin("url", "https://example.com/spec").ref).toBe("example.com")
  })
  it("rejects invalid references and URLs that can execute code or leak credentials", () => {
    for (const input of ["", "javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"]) {
      expect(() => taskSourceOrigin("url", input)).toThrow()
    }
    expect(() => taskSourceOrigin("clickup", "https://app.clickup.com.evil.test/t/123")).toThrow()
    expect(() => taskSourceOrigin("sentry", "https://sentry.io/settings")).toThrow()
    expect(() => normalizeSessionOrigin({ kind: "url", ref: "test", url: "javascript:alert(1)" })).toThrow()
    expect(() => normalizeSessionOrigin({ kind: "unknown", ref: "test", url: "https://example.com" })).toThrow()
    expect(normalizeSessionOrigin(undefined)).toBeUndefined()
  })
  it("carries the exact reference into editable MCP prompts without authorizing external updates", () => {
    const clickup = buildTaskSourcePrompt("clickup", "https://app.clickup.com/t/123")
    expect(clickup).toContain("Read task https://app.clickup.com/t/123 with the ClickUp MCP")
    expect(clickup).toContain("acceptance criteria")
    expect(clickup).toContain("Do not post comments or change the task status")
    const sentry = buildTaskSourcePrompt("sentry", "https://org.sentry.io/issues/7")
    expect(sentry).toContain("latest event and stack trace")
    expect(sentry).toContain("regression test")
    expect(buildTaskSourcePrompt("url", "https://example.com/spec")).toContain("https://example.com/spec")
  })
})
