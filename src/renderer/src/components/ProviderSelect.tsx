import type { ProviderId, ProviderInfo } from "@shared/types"

type Props = {
  providers: ProviderInfo[]
  value: ProviderId
  onChange: (id: ProviderId) => void
}

export function ProviderSelect({ providers, value, onChange }: Props) {
  const selected = providers.find((p) => p.id === value)

  return (
    <div className="new-session-row">
      <select
        className="provider-select"
        value={value}
        onChange={(e) => onChange(e.target.value as ProviderId)}
        aria-label="Provider"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.label}
            {!p.available ? " (soon)" : ""}
          </option>
        ))}
      </select>
      {selected ? (
        <div className="provider-hint">{selected.description}</div>
      ) : null}
    </div>
  )
}
