import { SourceControl } from "../SourceControl"

type Props = {
  cwd: string
  refreshKey: number
  focus: { path: string; at: number } | null
  onClose: () => void
  onChanged: () => void
}

export function DiffSurface({ cwd, refreshKey, focus, onClose, onChanged }: Props) {
  return (
    <div className="surface-diff">
      <SourceControl
        cwd={cwd}
        refreshKey={refreshKey}
        focus={focus}
        onClose={onClose}
        onChanged={onChanged}
      />
    </div>
  )
}
