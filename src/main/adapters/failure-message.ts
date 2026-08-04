/**
 * Turn a CLI exit into one actionable transcript message.  The tail is kept
 * because it is the only useful diagnostic a local CLI often gives us, but a
 * generic "enable auto approve" hint is deliberately avoided: permissions
 * are a user choice, not an error recovery mechanism.
 */
export function renderCliFailure(
  provider: "Grok" | "OpenCode",
  code: number,
  stderr: string[],
): string {
  const tail = stderr
    .slice(-8)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
    .join("\n")
    .trim()
  const lower = tail.toLowerCase()
  const loginHint =
    provider === "OpenCode" &&
    /(credential|auth|api key|provider.*not.*configured|no model)/.test(lower)
      ? "\n\nOpenCode is not connected to a model provider. Run `opencode auth login`, choose a provider, then retry."
      : ""
  const diagnostic = tail || "(no diagnostic output from the CLI)"
  return `**${provider} could not complete this turn** (exit code ${code}).\n\n\`\`\`\n${diagnostic}\n\`\`\`${loginHint}`
}
