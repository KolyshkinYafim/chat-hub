function lineClass(line: string): string {
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "ctx"
}

export function DiffBody({ code }: { code: string }) {
  const lines = code.split("\n")
  const added = lines.filter((l) => l.startsWith("+")).length
  const removed = lines.filter((l) => l.startsWith("-")).length
  return (
    <div className="md-diff">
      <div className="md-diff-head">
        <span className="diff-ico">±</span>
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <pre>
        <code>
          {lines.map((line, i) => (
            <span key={i} className={`diff-line ${lineClass(line)}`}>
              {line || " "}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
