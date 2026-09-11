/** Remove internal transcript blocks before exporting an assistant's prose.
 * Honor variable-length fences: tool output can itself contain Markdown fences.
 * An unfinished private block stays excluded through the end of the message.
 */
export function assistantExportText(content: string): string {
  const out: string[] = []
  let fenceLength = 0
  let privateBlock = false
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const fence = /^\s*(`{3,})(.*)$/.exec(line)
    if (fenceLength) {
      if (fence && fence[1].length >= fenceLength && !fence[2].trim()) {
        if (!privateBlock) out.push(line)
        fenceLength = 0; privateBlock = false
      } else if (!privateBlock) out.push(line)
      continue
    }
    if (fence) {
      const kind = fence[2].trim().toLowerCase()
      fenceLength = fence[1].length
      privateBlock = /^(?:tool:|tool-result:)/.test(kind) || ["thinking", "reasoning", "diff"].includes(kind)
      if (!privateBlock) out.push(line)
    } else out.push(line)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}
