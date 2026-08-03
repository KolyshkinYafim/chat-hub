import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { SettingsStore } from "./settings"
import { ProjectStore } from "./project-store"
import { sealSecret, openSecret, encryptionAvailable } from "./secret"
import { probeProvider, testProvider } from "./provider-probe"
import { toolUseBlock } from "./adapters/stream-parse"

/**
 * Dev self-test for the Providers T3-parity work. Guarded by CHAT_HUB_SELFTEST=1.
 * Exercises the REAL settings / secret / probe modules inside Electron (where
 * safeStorage is available) and prints a PASS/FAIL block to the console.
 */
export async function runProvidersSelfTest(): Promise<void> {
  const results: string[] = []
  let failures = 0
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) failures++
    results.push(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`)
  }

  const file = join(tmpdir(), `chat-hub-selftest-${process.pid}.json`)
  try {
    // 1. secret round-trip
    const sealed = sealSecret("sk-secret-123")
    check("secret is not stored as plaintext", !sealed.includes("sk-secret-123"), sealed.slice(0, 24))
    check("secret round-trips", openSecret(sealed) === "sk-secret-123")
    results.push(`info — encryptionAvailable=${encryptionAvailable()}`)

    // 2. settings store persist + seal + redact
    const store = new SettingsStore(file)
    await store.load()
    await store.setProviderConfig("claude", {
      enabled: false,
      binaryPath: "/tmp/fake-claude",
      defaultModel: "opus",
      env: { ANTHROPIC_API_KEY: "sk-test-abc" },
    })

    const onDisk = readFileSync(file, "utf8")
    check("api key NOT plaintext on disk", !onDisk.includes("sk-test-abc"))
    check("getProviderEnv decrypts key", store.getProviderEnv("claude").ANTHROPIC_API_KEY === "sk-test-abc")
    check("envKeys lists the key", JSON.stringify(store.getProviderEnvKeys("claude")) === JSON.stringify(["ANTHROPIC_API_KEY"]))
    check("isProviderEnabled reflects false", store.isProviderEnabled("claude") === false)
    const redacted = store.redactedProviders()
    check("redacted providers drop env", !("env" in (redacted.claude ?? {})))
    check("redacted keeps binaryPath", redacted.claude?.binaryPath === "/tmp/fake-claude")
    check("redacted keeps enabled=false", redacted.claude?.enabled === false)

    // 3. env delete via empty value
    await store.setProviderConfig("claude", { env: { ANTHROPIC_API_KEY: "" } })
    check("empty value deletes env key", store.getProviderEnvKeys("claude").length === 0)

    // 4. persistence across reload
    const store2 = new SettingsStore(file)
    await store2.load()
    check("enabled=false persists across reload", store2.isProviderEnabled("claude") === false)
    check("binaryPath persists across reload", store2.getProviderConfig("claude").binaryPath === "/tmp/fake-claude")

    // 4b. general config persist
    await store2.setGeneralConfig({ defaultProvider: "grok", defaultEffort: "max", editor: "code" })
    const store3 = new SettingsStore(file)
    await store3.load()
    check("general.defaultProvider persists", store3.general.defaultProvider === "grok")
    check("general.defaultEffort persists", store3.general.defaultEffort === "max")
    check("general.editor persists", store3.general.editor === "code")

    // 4c. provider instances (shadow homes) CRUD + resolveInstance
    const inst = await store3.addInstance("codex", {
      label: "Codex (work)",
      homeDir: "/tmp/codex-work",
    })
    check("addInstance returns id", typeof inst.id === "string" && inst.id.length > 0)
    check("listInstances contains it", store3.listInstances().some((i) => i.id === inst.id))
    const rInst = store3.resolveInstance(inst.id)
    check("resolveInstance(extra): provider + isExtra", rInst?.provider === "codex" && rInst?.isExtra === true)
    check("resolveInstance(extra): CODEX_HOME env injected", rInst?.env.CODEX_HOME === "/tmp/codex-work")
    const rDefault = store3.resolveInstance("claude")
    check("resolveInstance(default): not extra", rDefault?.provider === "claude" && rDefault?.isExtra === false)
    // Default instance carries no home env.
    check("resolveInstance(default): no home env", Object.keys(rDefault?.env ?? {}).every((k) => k !== "CLAUDE_CONFIG_DIR"))
    await store3.updateInstance(inst.id, { label: "Codex (personal)" })
    check("updateInstance changes label", store3.listInstances().find((i) => i.id === inst.id)?.label === "Codex (personal)")
    // instances persist across reload
    const store4 = new SettingsStore(file)
    await store4.load()
    check("instances persist across reload", store4.listInstances().some((i) => i.id === inst.id))
    await store4.removeInstance(inst.id)
    check("removeInstance drops it", !store4.listInstances().some((i) => i.id === inst.id))

    // 5. probe honors envKeys + enabled
    const probed = await probeProvider({ provider: "claude", envKeys: ["ANTHROPIC_API_KEY"], enabled: false })
    check("probe: enabled=false surfaced", probed.enabled === false)
    check("probe: envKeys surfaced", probed.envKeys.includes("ANTHROPIC_API_KEY"))
    check("probe: envHints present", probed.envHints.some((h) => h.key === "ANTHROPIC_API_KEY"))
    check("probe: default instanceId === provider", probed.instanceId === "claude" && probed.isExtra === false)
    check(
      "probe: ANTHROPIC_API_KEY => connected auth (when installed)",
      probed.installed ? probed.auth === "connected" : true,
      `installed=${probed.installed} auth=${probed.auth}`,
    )

    const probedGrok = await probeProvider({ provider: "grok" })
    results.push(`info — grok auth=${probedGrok.auth} detail="${probedGrok.authDetail}"`)
    const probedCodex = await probeProvider({ provider: "codex" })
    results.push(`info — codex installed=${probedCodex.installed} path=${probedCodex.binaryPath ?? "-"} auth=${probedCodex.auth}`)

    // 5b. extra instance (shadow home) probe reflects the home dir
    const shadowHome = join(tmpdir(), `chat-hub-shadow-${process.pid}`)
    const probedExtra = await probeProvider({
      provider: "codex",
      instanceId: "inst-x",
      isExtra: true,
      label: "Codex (work)",
      homeDir: shadowHome,
      env: { CODEX_HOME: shadowHome },
    })
    check("probe: extra instance keeps its id", probedExtra.instanceId === "inst-x" && probedExtra.isExtra)
    check("probe: extra instance keeps its label", probedExtra.label === "Codex (work)")
    check("probe: extra instance surfaces homeDir", probedExtra.homeDir === shadowHome)
    check(
      "probe: empty shadow home => needs_login (not the default account)",
      probedExtra.installed ? probedExtra.auth === "needs_login" : true,
      `auth=${probedExtra.auth} detail="${probedExtra.authDetail}"`,
    )

    // 6. ProjectStore: add / dedup / rename / remove / persist
    const projFile = join(tmpdir(), `chat-hub-selftest-projects-${process.pid}.json`)
    const dirA = await mkdtemp(join(tmpdir(), "chatp-a-"))
    const dirB = await mkdtemp(join(tmpdir(), "chatp-b-"))
    try {
      const ps = new ProjectStore(projFile)
      await ps.load()
      const a = await ps.add(dirA)
      const a2 = await ps.add(dirA, "Renamed-attempt")
      check("project add is idempotent on cwd", a.id === a2.id, `${a.id} vs ${a2.id}`)
      await ps.add(dirB, "Beta")
      check("two distinct folders => two projects", ps.list().length === 2)
      check("add with name uses given name", ps.list().some((p) => p.name === "Beta"))

      await ps.renameProject(a.id, "Alpha")
      check("renameProject updates name", ps.list().find((p) => p.id === a.id)?.name === "Alpha")

      const ps2 = new ProjectStore(projFile)
      await ps2.load()
      check("projects persist across reload", ps2.list().length === 2)
      check("renamed name persists", ps2.list().find((p) => p.id === a.id)?.name === "Alpha")

      await ps2.remove(a.id)
      check("removeProject drops entry", ps2.list().length === 1)

      // ensure() swallows non-existent folders
      await ps2.ensure(join(tmpdir(), "definitely-not-here-xyz"))
      check("ensure ignores missing folder", ps2.list().length === 1)
    } finally {
      await rm(projFile, { force: true }).catch(() => {})
      await rm(`${projFile}.tmp`, { force: true }).catch(() => {})
      await rm(dirA, { recursive: true, force: true }).catch(() => {})
      await rm(dirB, { recursive: true, force: true }).catch(() => {})
    }

    // 7. tool card + diff rendering (stream-parse)
    {
      const edit = toolUseBlock("Edit", {
        file_path: "src/a.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      })
      check("tool card fences the name", edit.includes("```tool:Edit"))
      check("tool card shows file path", edit.includes("src/a.ts"))
      check("edit emits a diff block", edit.includes("```diff"))
      check(
        "diff has removal + addition",
        edit.includes("- const x = 1") && edit.includes("+ const x = 2"),
      )
      const bash = toolUseBlock("Bash", { command: "npm test" })
      check("bash card shows command", bash.includes("$ npm test"))
    }

    // 8. Test connection (real CLI call — tolerant of network/flake)
    {
      const mockTest = await testProvider({ provider: "mock" })
      check("test: mock connection returns ok", mockTest.ok === true)
      const claudeTest = await testProvider({ provider: "claude" })
      check(
        "test: claude returns well-formed result",
        typeof claudeTest.ok === "boolean" && typeof claudeTest.ms === "number",
      )
      results.push(
        `info — claude Test connection: ok=${claudeTest.ok} ms=${claudeTest.ms} detail="${claudeTest.detail.slice(0, 80)}"`,
      )
    }
  } catch (err) {
    failures++
    results.push(`FAIL — threw: ${err instanceof Error ? err.stack : String(err)}`)
  } finally {
    await rm(file, { force: true }).catch(() => {})
    await rm(`${file}.tmp`, { force: true }).catch(() => {})
  }

  console.log("\n=== CHAT_HUB PROVIDERS SELFTEST BEGIN ===")
  for (const line of results) console.log(line)
  console.log(`=== SELFTEST END — ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===\n`)
}
