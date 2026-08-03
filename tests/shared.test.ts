import { afterEach, describe, expect, it } from "vitest"
import {
  claudePermissionArgs,
  grokPermissionArgs,
  opencodeAutoApprove,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_LABELS,
  PERMISSION_HINTS,
} from "../src/shared/permission"
import {
  agentDesktopCommandsPath,
  agentDesktopEventsPath,
} from "../src/shared/bridge-path"
import { normalizeProject, projectFromCwd } from "../src/shared/project"

describe("permission modes", () => {
  it("defaults to YOLO — the whole point of the Hub", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("yolo")
  })

  it("has a label and a hint for every mode", () => {
    for (const mode of ["yolo", "acceptEdits", "default"] as const) {
      expect(PERMISSION_LABELS[mode]).toBeTruthy()
      expect(PERMISSION_HINTS[mode]).toBeTruthy()
    }
  })

  it("passes both bypass flags to Claude so old and new CLIs both obey", () => {
    const args = claudePermissionArgs("yolo")
    expect(args).toContain("--dangerously-skip-permissions")
    expect(args.join(" ")).toContain("--permission-mode bypassPermissions")
  })

  it("never leaks bypass into the non-YOLO Claude modes", () => {
    for (const mode of ["acceptEdits", "default"] as const) {
      const joined = claudePermissionArgs(mode).join(" ")
      expect(joined).not.toContain("bypassPermissions")
      expect(joined).not.toContain("--dangerously-skip-permissions")
    }
  })

  it("passes no --permission-mode for Claude's Ask mode", () => {
    // Claude 2.x's choices do not include "default" and commander hard-fails,
    // so Ask has to be expressed by omitting the flag.
    expect(claudePermissionArgs("default")).toEqual([])
  })

  it("uses Grok's own always-approve flag for YOLO only", () => {
    expect(grokPermissionArgs("yolo")).toContain("--always-approve")
    expect(grokPermissionArgs("acceptEdits")).not.toContain("--always-approve")
    expect(grokPermissionArgs("default")).not.toContain("--always-approve")
  })

  it("auto-approves OpenCode for yolo and acceptEdits, not for ask", () => {
    expect(opencodeAutoApprove("yolo")).toBe(true)
    expect(opencodeAutoApprove("acceptEdits")).toBe(true)
    expect(opencodeAutoApprove("default")).toBe(false)
  })
})

describe("bridge paths", () => {
  const savedEvents = process.env.AGENT_DESKTOP_EVENTS
  const savedCommands = process.env.AGENT_DESKTOP_COMMANDS

  afterEach(() => {
    if (savedEvents === undefined) delete process.env.AGENT_DESKTOP_EVENTS
    else process.env.AGENT_DESKTOP_EVENTS = savedEvents
    if (savedCommands === undefined) delete process.env.AGENT_DESKTOP_COMMANDS
    else process.env.AGENT_DESKTOP_COMMANDS = savedCommands
  })

  it("puts events and commands side by side in one folder", () => {
    delete process.env.AGENT_DESKTOP_EVENTS
    delete process.env.AGENT_DESKTOP_COMMANDS
    const events = agentDesktopEventsPath()
    const commands = agentDesktopCommandsPath()
    expect(events).toMatch(/agent-desktop[/\\]events\.jsonl$/)
    expect(commands).toMatch(/agent-desktop[/\\]commands\.jsonl$/)
    expect(events.replace(/events\.jsonl$/, "")).toBe(
      commands.replace(/commands\.jsonl$/, ""),
    )
  })

  it("honours the env override the Monitor and hooks also read", () => {
    process.env.AGENT_DESKTOP_EVENTS = "/tmp/custom-events.jsonl"
    process.env.AGENT_DESKTOP_COMMANDS = "/tmp/custom-commands.jsonl"
    expect(agentDesktopEventsPath()).toBe("/tmp/custom-events.jsonl")
    expect(agentDesktopCommandsPath()).toBe("/tmp/custom-commands.jsonl")
  })
})

describe("project naming", () => {
  it("uses the folder basename", () => {
    expect(projectFromCwd("/Users/me/code/mary")).toBe("mary")
    expect(projectFromCwd("/Users/me/code/mary/")).toBe("mary")
  })

  it("refuses to name a project after a generic home folder", () => {
    expect(projectFromCwd("/Users/me/Desktop")).toBe("Workspace")
    expect(projectFromCwd("/")).toBe("Workspace")
    expect(projectFromCwd("")).toBe("Workspace")
  })

  it("normalises windows separators", () => {
    expect(projectFromCwd("C:\\code\\mary")).toBe("mary")
  })

  it("prefers an explicit name, ignoring blank ones", () => {
    expect(normalizeProject("Mary API", "/Users/me/code/mary")).toBe("Mary API")
    expect(normalizeProject("   ", "/Users/me/code/mary")).toBe("mary")
    expect(normalizeProject(undefined, "/Users/me/code/mary")).toBe("mary")
  })
})
