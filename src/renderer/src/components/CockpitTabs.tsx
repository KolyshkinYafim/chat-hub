export const COCKPIT_TABS = [
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "diff", label: "Diff" },
] as const

export type CockpitTab = (typeof COCKPIT_TABS)[number]["id"]

type Props = {
  value: CockpitTab
  onChange: (tab: CockpitTab) => void
  surfacesEnabled: boolean
}

export function CockpitTabs({ value, onChange, surfacesEnabled }: Props) {
  return (
    <div className="cockpit-tabs" role="tablist" aria-label="Session views">
      {COCKPIT_TABS.map((tab) => {
        const disabled = tab.id !== "chat" && !surfacesEnabled
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            disabled={disabled}
            className={`cockpit-tab${value === tab.id ? " is-active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
