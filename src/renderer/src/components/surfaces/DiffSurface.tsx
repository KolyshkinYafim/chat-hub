import { SourceControl } from "../SourceControl"

type Props = {
  cwd: string
  refreshKey: number
  onClose: () => void
  onChanged: () => void
}

export function DiffSurface({ cwd, refreshKey, onClose, onChanged }: Props) {
  return (
    <div className="surface-diff">
      <SourceControl
        cwd={cwd}
        refreshKey={refreshKey}
        onClose={onClose}
        onChanged={onChanged}
      />
    </div>
  )
}
