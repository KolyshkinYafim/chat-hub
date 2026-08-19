import { useEffect, useRef, useState } from "react"
import type { PermissionMode } from "@shared/permission"
import { PERMISSION_HINTS, PERMISSION_LABELS } from "@shared/permission"
import type { ModelInfo, Mode } from "@shared/settings-types"
import {
  composerSummary,
  EFFORT_LABELS,
  modelLabel,
  PERMISSION_SHORT,
  type Effort,
} from "../lib/composer-summary"

type Pane = "root" | "model" | "mode" | "permission" | "effort"

type Props = {
  providerLabel: string
  model: string | undefined
  models: ModelInfo[]
  modeId: string | undefined
  modes: Mode[]
  permissionMode: PermissionMode
  effort: Effort
  availableEfforts: Effort[]
  supportsEffort: boolean
  onModelChange: (model: string) => void
  onApplyMode: (modeId: string) => void
  onPermissionChange: (mode: PermissionMode) => void
  onEffortChange: (effort: Effort) => void
}

export function ComposerMenu(props: Props) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>("root")
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) setPane("root")
  }, [open])

  const activeMode = props.modes.find((m) => m.id === props.modeId)
  const summary = composerSummary(props)

  function pick<T>(apply: (value: T) => void): (value: T) => void {
    return (value) => {
      apply(value)
      setPane("root")
    }
  }

  return (
    <div className="composer-menu" ref={rootRef}>
      <button
        type="button"
        className={`composer-pill perm-${props.permissionMode}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${props.providerLabel} · ${summary} · ${PERMISSION_LABELS[props.permissionMode]}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="composer-pill-dot" aria-hidden />
        <span className="composer-pill-provider">{props.providerLabel}</span>
        <span className="composer-pill-summary">{summary}</span>
        {activeMode ? (
          <span className="composer-pill-mode">◈ {activeMode.name}</span>
        ) : null}
        <svg
          className={`composer-pill-caret ${open ? "is-open" : ""}`}
          aria-hidden
          width="8"
          height="8"
          viewBox="0 0 8 8"
        >
          <path
            d="M1.5 5.25 4 2.75l2.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          className="composer-popover"
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return
            e.stopPropagation()
            if (pane !== "root") setPane("root")
            else setOpen(false)
          }}
        >
          {pane === "root" ? (
            <div className="composer-pane">
              <div className="composer-pane-head">{props.providerLabel}</div>
              <MenuRow
                label="Model"
                value={modelLabel(props.model, props.models)}
                disabled={props.models.length === 0}
                onOpen={() => setPane("model")}
              />
              {props.modes.length > 0 ? (
                <MenuRow
                  label="Mode"
                  value={activeMode?.name ?? "No mode"}
                  onOpen={() => setPane("mode")}
                />
              ) : null}
              <MenuRow
                label="Permissions"
                value={PERMISSION_SHORT[props.permissionMode]}
                valueClass={`perm-value perm-${props.permissionMode}`}
                onOpen={() => setPane("permission")}
              />
              <MenuRow
                label="Effort"
                value={
                  props.supportsEffort ? EFFORT_LABELS[props.effort] : "n/a"
                }
                disabled={!props.supportsEffort}
                onOpen={() => setPane("effort")}
              />
            </div>
          ) : null}

          {pane === "model" ? (
            <OptionPane
              title="Model"
              onBack={() => setPane("root")}
              options={[
                { id: "", label: "CLI default" },
                ...(props.model &&
                !props.models.some((m) => m.id === props.model)
                  ? [{ id: props.model, label: `${props.model} · not probed` }]
                  : []),
                ...props.models.map((m) => ({ id: m.id, label: m.label })),
              ]}
              selected={props.model ?? ""}
              onSelect={pick(props.onModelChange)}
            />
          ) : null}

          {pane === "mode" ? (
            <OptionPane
              title="Mode"
              onBack={() => setPane("root")}
              options={[
                { id: "", label: "No mode" },
                ...props.modes.map((m) => ({ id: m.id, label: m.name })),
              ]}
              selected={props.modeId ?? ""}
              onSelect={pick(props.onApplyMode)}
            />
          ) : null}

          {pane === "permission" ? (
            <OptionPane
              title="Permissions"
              onBack={() => setPane("root")}
              options={(["yolo", "acceptEdits", "default"] as PermissionMode[]).map(
                (m) => ({
                  id: m,
                  label: PERMISSION_LABELS[m],
                  hint: PERMISSION_HINTS[m],
                }),
              )}
              selected={props.permissionMode}
              onSelect={pick((id: string) =>
                props.onPermissionChange(id as PermissionMode),
              )}
            />
          ) : null}

          {pane === "effort" ? (
            <OptionPane
              title="Effort"
              onBack={() => setPane("root")}
              options={props.availableEfforts.map((level) => ({
                id: level,
                label: EFFORT_LABELS[level],
              }))}
              selected={props.effort}
              onSelect={pick((id: string) => props.onEffortChange(id as Effort))}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MenuRow({
  label,
  value,
  valueClass,
  disabled,
  onOpen,
}: {
  label: string
  value: string
  valueClass?: string
  disabled?: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="composer-menu-row"
      role="menuitem"
      disabled={disabled}
      onClick={onOpen}
    >
      <span className="composer-menu-label">{label}</span>
      <span className={`composer-menu-value ${valueClass ?? ""}`}>{value}</span>
      <span className="composer-menu-chevron" aria-hidden>
        ›
      </span>
    </button>
  )
}

function OptionPane({
  title,
  options,
  selected,
  onBack,
  onSelect,
}: {
  title: string
  options: { id: string; label: string; hint?: string }[]
  selected: string
  onBack: () => void
  onSelect: (id: string) => void
}) {
  return (
    <div className="composer-pane">
      <button type="button" className="composer-pane-back" onClick={onBack}>
        <span aria-hidden>‹</span> {title}
      </button>
      {options.map((option) => (
        <button
          key={option.id || "(none)"}
          type="button"
          className="composer-option"
          role="menuitemradio"
          aria-checked={option.id === selected}
          title={option.hint}
          onClick={() => onSelect(option.id)}
        >
          <span className="composer-option-label">{option.label}</span>
          {option.id === selected ? (
            <span className="composer-option-check" aria-hidden>
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
