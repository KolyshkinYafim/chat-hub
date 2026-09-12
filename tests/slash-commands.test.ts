import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  describeCommandFile,
  invalidateSlashCommands,
  listSlashCommands,
  scanSlashCommands,
} from "../src/main/slash-commands"
import {
  filterSlashCommands,
  insertSlashCommand,
  slashQuery,
} from "../src/renderer/src/lib/slash-commands"
import type { SlashCommand } from "../src/shared/slash-commands"

let cwd = ""
let home = ""

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-slash-"))
  cwd = join(root, "project")
  home = join(root, "home")
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  invalidateSlashCommands()
})

describe("describeCommandFile", () => {
  it("prefers the frontmatter description", () => {
    const text = "---\nname: mr-review\ndescription: \"Review before an MR\"\n---\n# Heading\nbody"
    expect(describeCommandFile(text)).toEqual({
      name: "mr-review",
      description: "Review before an MR",
    })
  })

  it("falls back to the first prose line, without the heading marks", () => {
    expect(describeCommandFile("\n\n## Fix the failing tests\n\nmore")).toEqual({
      description: "Fix the failing tests",
    })
  })

  it("skips frontmatter without a description when looking for prose", () => {
    expect(describeCommandFile("---\nallowed-tools: Bash\n---\nRun the suite.")).toEqual({
      description: "Run the suite.",
    })
  })

  it("drops a frontmatter name that could not be typed on the line", () => {
    expect(describeCommandFile("---\nname: has space\n---\nx").name).toBeUndefined()
  })

  it("returns an empty description for an empty file", () => {
    expect(describeCommandFile("").description).toBe("")
  })
})

describe("scanSlashCommands", () => {
  it("finds Claude skills and commands in the project and the home dir", async () => {
    await put(
      join(cwd, ".claude", "skills", "deploy", "SKILL.md"),
      "---\ndescription: Ship it\n---\n",
    )
    await put(join(cwd, ".claude", "commands", "fix.md"), "Fix the thing")
    await put(join(home, ".claude", "skills", "changelog", "SKILL.md"), "# Changelog\n")
    await put(join(home, ".claude", "commands", "review.md"), "")
    // Not commands: a skill dir without SKILL.md, a non-markdown file.
    await mkdir(join(cwd, ".claude", "skills", "broken"), { recursive: true })
    await put(join(cwd, ".claude", "commands", "notes.txt"), "no")

    const list = await scanSlashCommands("claude", cwd, { home })
    expect(list).toEqual<SlashCommand[]>([
      { name: "changelog", description: "Changelog", source: "user", provider: "claude" },
      { name: "deploy", description: "Ship it", source: "project", provider: "claude" },
      { name: "fix", description: "Fix the thing", source: "project", provider: "claude" },
      { name: "review", description: "", source: "user", provider: "claude" },
    ])
  })

  it("lets the project's copy shadow the user's", async () => {
    await put(join(cwd, ".claude", "commands", "review.md"), "Project review")
    await put(join(home, ".claude", "commands", "review.md"), "User review")
    const list = await scanSlashCommands("claude", cwd, { home })
    expect(list).toEqual([
      { name: "review", description: "Project review", source: "project", provider: "claude" },
    ])
  })

  it("reads Codex prompts from both places and ignores Claude's", async () => {
    await put(join(home, ".codex", "prompts", "tidy.md"), "Tidy the diff")
    await put(join(cwd, ".codex", "prompts", "release.md"), "---\ndescription: Cut a release\n---\n")
    await put(join(cwd, ".claude", "commands", "fix.md"), "Fix")
    const list = await scanSlashCommands("codex", cwd, { home })
    expect(list.map((c) => [c.name, c.source, c.description])).toEqual([
      ["release", "project", "Cut a release"],
      ["tidy", "user", "Tidy the diff"],
    ])
  })

  it("is empty for a provider without a command convention", async () => {
    await put(join(cwd, ".claude", "commands", "fix.md"), "Fix")
    expect(await scanSlashCommands("grok", cwd, { home })).toEqual([])
    expect(await scanSlashCommands("ollama", cwd, { home })).toEqual([])
  })

  it("is empty when nothing is on disk", async () => {
    expect(await scanSlashCommands("claude", cwd, { home })).toEqual([])
  })
})

describe("listSlashCommands cache", () => {
  it("serves the same scan within the TTL and rescans after it or on invalidate", async () => {
    let t = 0
    const now = () => t
    await put(join(cwd, ".claude", "commands", "a.md"), "A")
    const first = await listSlashCommands("claude", cwd, { home, now })
    expect(first.map((c) => c.name)).toEqual(["a"])

    await put(join(cwd, ".claude", "commands", "b.md"), "B")
    t = 5_000
    expect((await listSlashCommands("claude", cwd, { home, now })).map((c) => c.name)).toEqual(["a"])

    t = 20_000
    expect((await listSlashCommands("claude", cwd, { home, now })).map((c) => c.name)).toEqual([
      "a",
      "b",
    ])

    await put(join(cwd, ".claude", "commands", "c.md"), "C")
    invalidateSlashCommands("claude", cwd)
    expect((await listSlashCommands("claude", cwd, { home, now })).map((c) => c.name)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("keys the cache by provider and cwd", async () => {
    await put(join(cwd, ".claude", "commands", "a.md"), "A")
    await put(join(cwd, ".codex", "prompts", "p.md"), "P")
    expect((await listSlashCommands("claude", cwd, { home })).map((c) => c.name)).toEqual(["a"])
    expect((await listSlashCommands("codex", cwd, { home })).map((c) => c.name)).toEqual(["p"])
  })
})

const cmd = (name: string, source: SlashCommand["source"] = "project"): SlashCommand => ({
  name,
  description: "",
  source,
  provider: "claude",
})

describe("slashQuery", () => {
  it("is the name being typed after a leading slash", () => {
    expect(slashQuery("/")).toBe("")
    expect(slashQuery("/rev")).toBe("rev")
  })

  it("is null once the command has arguments, or when there is no slash", () => {
    expect(slashQuery("/review src")).toBeNull()
    expect(slashQuery("/review\n")).toBeNull()
    expect(slashQuery("review")).toBeNull()
    expect(slashQuery(" /review")).toBeNull()
    expect(slashQuery("")).toBeNull()
  })
})

describe("filterSlashCommands", () => {
  const all = [cmd("changelog"), cmd("code-review"), cmd("mr-review"), cmd("review")]

  it("lists everything on an empty query, capped", () => {
    expect(filterSlashCommands(all, "").map((c) => c.name)).toEqual([
      "changelog",
      "code-review",
      "mr-review",
      "review",
    ])
    expect(filterSlashCommands(all, "", 2)).toHaveLength(2)
  })

  it("puts the prefix match first and keeps fuzzy hits after it", () => {
    const names = filterSlashCommands(all, "rev").map((c) => c.name)
    expect(names[0]).toBe("review")
    expect(names).toContain("code-review")
    expect(names).toContain("mr-review")
    expect(names).not.toContain("changelog")
  })

  it("drops names the query does not fit", () => {
    expect(filterSlashCommands(all, "xyz")).toEqual([])
  })
})

describe("insertSlashCommand", () => {
  it("leaves the caret after a space, ready for arguments", () => {
    expect(insertSlashCommand("review")).toBe("/review ")
  })
})
