import { describe, expect, it } from "vitest"
import {
  CONTEXT_DOCS,
  buildContextBrief,
  contextDocSpec,
  contextHeadline,
  estimateContextTokens,
  parseContextSettings,
  type ContextDoc,
  type ContextDocId,
} from "../src/shared/project-context"
import {
  detectProject,
  normalizeRemoteUrl,
  parseGitConfigRemote,
  seedContextDocs,
  type DetectInput,
} from "../src/shared/project-detect"

const doc = (id: ContextDocId, text: string): ContextDoc => {
  const spec = CONTEXT_DOCS.find((s) => s.id === id)!
  return { id, file: spec.file, title: spec.title, text, updatedAt: 1 }
}

const input = (patch: Partial<DetectInput> = {}): DetectInput => ({
  folderName: "orbit-api",
  packageJson: null,
  gitConfig: null,
  entries: [],
  directories: [],
  ...patch,
})

const PACKAGE_JSON = JSON.stringify({
  name: "@acme/orbit",
  description: "Task orchestration API.",
  scripts: { dev: "vite", test: "vitest run", build: "tsc -b", nope: "true" },
  dependencies: { react: "^19.0.0", fastify: "^5.0.0" },
  devDependencies: { typescript: "^5.8.0", vitest: "^3.0.0" },
})

describe("detectProject", () => {
  it("reads name, description, scripts and dependencies out of package.json", () => {
    const facts = detectProject(
      input({ packageJson: PACKAGE_JSON, entries: ["package.json"] }),
    )
    expect(facts.name).toBe("@acme/orbit")
    expect(facts.description).toBe("Task orchestration API.")
    expect(facts.frameworks).toEqual(["React", "Fastify", "Vitest"])
    // Ordered by what a newcomer needs first, and unknown scripts are dropped.
    expect(facts.scripts.map((s) => s.name)).toEqual(["dev", "build", "test"])
  })

  it("falls back to the folder name when there is no package.json", () => {
    const facts = detectProject(input({ entries: ["go.mod", "Makefile"] }))
    expect(facts.name).toBe("orbit-api")
    expect(facts.languages).toEqual(["Go"])
    expect(facts.packageManager).toBeNull()
  })

  it("names the package manager from the lockfile, not the field", () => {
    const facts = detectProject(
      input({
        packageJson: JSON.stringify({ packageManager: "yarn@4.0.0" }),
        entries: ["package.json", "pnpm-lock.yaml"],
      }),
    )
    expect(facts.packageManager).toBe("pnpm")
  })

  it("prefers TypeScript over JavaScript and keeps other ecosystems", () => {
    const facts = detectProject(
      input({
        packageJson: "{}",
        entries: ["package.json", "tsconfig.json", "pyproject.toml"],
      }),
    )
    expect(facts.languages).toEqual(["TypeScript", "Python"])
  })

  it("survives a package.json that is not valid JSON", () => {
    const facts = detectProject(
      input({ packageJson: "{ this is not json", entries: ["package.json"] }),
    )
    expect(facts.name).toBe("orbit-api")
    expect(facts.scripts).toEqual([])
  })

  it("sorts and caps the top-level layout", () => {
    const facts = detectProject(
      input({
        directories: ["src", "tests", "docs", "a", "b", "c", "d", "e", "f"],
      }),
    )
    expect(facts.directories).toHaveLength(8)
    expect(facts.directories[0]).toBe("a")
  })
})

describe("remote detection", () => {
  it("normalizes the shapes a git remote actually comes in", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/orbit.git")).toBe(
      "https://github.com/acme/orbit",
    )
    expect(normalizeRemoteUrl("ssh://git@github.com:22/acme/orbit.git")).toBe(
      "https://github.com/acme/orbit",
    )
    expect(normalizeRemoteUrl("https://github.com/acme/orbit")).toBe(
      "https://github.com/acme/orbit",
    )
    expect(normalizeRemoteUrl("../sibling-repo")).toBeNull()
  })

  it("takes origin's url and ignores every other remote", () => {
    const config = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = git@github.com:upstream/orbit.git
[remote "origin"]
\turl = git@github.com:acme/orbit.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`
    expect(parseGitConfigRemote(config)).toBe("https://github.com/acme/orbit")
    expect(parseGitConfigRemote(null)).toBeNull()
    expect(parseGitConfigRemote("[core]\n\tbare = false\n")).toBeNull()
  })
})

describe("seedContextDocs", () => {
  it("writes the detected facts into files the owner only has to correct", () => {
    const facts = detectProject(
      input({
        packageJson: PACKAGE_JSON,
        gitConfig: '[remote "origin"]\n\turl = git@github.com:acme/orbit.git\n',
        entries: ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
        directories: ["src", "tests"],
      }),
    )
    const seeds = seedContextDocs(facts)
    expect(seeds.overview).toContain("**@acme/orbit**")
    expect(seeds.overview).toContain("Task orchestration API.")
    expect(seeds.overview).toContain("https://github.com/acme/orbit")
    expect(seeds.stack).toContain("TypeScript")
    expect(seeds.stack).toContain("pnpm")
    expect(seeds.stack).toContain("`pnpm run test` — vitest run")
    // The conventions file names the command this repo actually tests with.
    expect(seeds.conventions).toContain("`pnpm run test`")
    expect(seeds.focus).toContain(".chathub/board.json")
    for (const spec of CONTEXT_DOCS) {
      expect(seeds[spec.id].startsWith("# ")).toBe(true)
    }
  })

  it("still produces every document for a folder it can detect nothing about", () => {
    const seeds = seedContextDocs(detectProject(input()))
    for (const spec of CONTEXT_DOCS) {
      expect(seeds[spec.id].trim().length).toBeGreaterThan(0)
    }
    expect(seeds.stack).toContain("Add the languages")
  })
})

describe("buildContextBrief", () => {
  it("orders sections, drops empty ones and strips the file's own h1", () => {
    const brief = buildContextBrief([
      doc("overview", "# Overview\n\nAn API.\n"),
      doc("stack", "   "),
      doc("conventions", "# Conventions\n\n- Small diffs.\n"),
      doc("focus", ""),
    ])
    expect(brief).toContain("## Overview\nAn API.")
    expect(brief).toContain("## Conventions\n- Small diffs.")
    expect(brief).not.toContain("## Stack")
    // The brief supplies the only heading; the file's own h1 is gone.
    expect(brief.split("\n").some((line) => line.startsWith("# "))).toBe(false)
    expect(brief.indexOf("## Overview")).toBeLessThan(
      brief.indexOf("## Conventions"),
    )
  })

  it("is empty when every document is empty, so nothing is sent", () => {
    expect(buildContextBrief([doc("overview", "\n\n"), doc("focus", "")])).toBe("")
    // Todos supplement written context; alone they are just the board again.
    expect(buildContextBrief([], ["a todo"])).toBe("")
    expect(buildContextBrief([doc("overview", "")], ["a todo"])).toBe("")
  })

  it("carries the board's open todos under the focus heading", () => {
    const brief = buildContextBrief(
      [doc("focus", "# Current focus\n\nCutting over to streaming.\n")],
      ["Migrate the dashboard", "Delete the polling route"],
    )
    expect(brief).toContain("## Current focus\nCutting over to streaming.")
    expect(brief).toContain("- [ ] Migrate the dashboard")
    expect(brief).toContain(".chathub/board.json")
  })

  it("caps the todo list rather than pasting a whole backlog", () => {
    const todos = Array.from({ length: 12 }, (_, i) => `task ${i}`)
    const brief = buildContextBrief([doc("focus", "Now")], todos)
    expect(brief).toContain("- [ ] task 7")
    expect(brief).not.toContain("- [ ] task 8")
    expect(brief).toContain("…and 4 more")
  })

  it("truncates at the budget and says so", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const brief = buildContextBrief([doc("overview", long)], [], 500)
    expect(brief.length).toBeLessThan(700)
    expect(brief).toContain("Context truncated at 500 characters")
  })
})

describe("surface helpers", () => {
  it("estimates tokens from length and reports nothing for nothing", () => {
    expect(estimateContextTokens("")).toBe(0)
    expect(estimateContextTokens("   \n ")).toBe(0)
    expect(estimateContextTokens("a".repeat(400))).toBe(100)
  })

  it("takes the first line of prose as the board's headline", () => {
    expect(contextHeadline("# Overview\n\n**orbit** — an API.\n")).toBe(
      "orbit — an API.",
    )
    expect(contextHeadline("# Just A Title\n")).toBe("Just A Title")
    expect(contextHeadline("")).toBe("")
    expect(contextHeadline(`x${"y".repeat(200)}`)).toHaveLength(120)
  })

  it("only knows the four documents it defines", () => {
    expect(contextDocSpec("stack")?.file).toBe("stack.md")
    expect(contextDocSpec("../../.zshrc")).toBeNull()
    expect(contextDocSpec(undefined)).toBeNull()
  })

  it("shares by default, including for a file that is nonsense", () => {
    expect(parseContextSettings(null).share).toBe(true)
    expect(parseContextSettings({ share: "yes" }).share).toBe(true)
    expect(parseContextSettings({ share: false }).share).toBe(false)
    expect(parseContextSettings({ updatedAt: 42 }).updatedAt).toBe(42)
    expect(parseContextSettings({ updatedAt: -1 }).updatedAt).toBe(0)
  })
})
