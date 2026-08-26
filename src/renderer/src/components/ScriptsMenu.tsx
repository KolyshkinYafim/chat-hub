import { useState } from "react"
import {
  isValidPreviewUrl,
  isValidScriptCommand,
  isValidScriptHotkey,
  type ProjectScript,
} from "@shared/scripts"
import { errorText } from "../lib/surface-bridge"

type Props = {
  scripts: ProjectScript[]
  onRun: (script: ProjectScript) => void
  onSave: (scripts: ProjectScript[]) => Promise<void>
}

type DraftScript = {
  id: string
  name: string
  command: string
  hotkey: string
  previewUrl: string
  autoOpenPreview: boolean
  runOnWorktreeCreate: boolean
}

function toDraft(script: ProjectScript): DraftScript {
  return {
    id: script.id,
    name: script.name,
    command: script.command,
    hotkey: script.hotkey ?? "",
    previewUrl: script.previewUrl ?? "",
    autoOpenPreview: script.autoOpenPreview,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
  }
}

function toScript(draft: DraftScript): ProjectScript {
  const previewUrl = draft.previewUrl.trim()
  return {
    id: draft.id,
    name: draft.name.trim(),
    command: draft.command.trim(),
    ...(draft.hotkey !== "" ? { hotkey: draft.hotkey } : {}),
    ...(previewUrl !== "" ? { previewUrl } : {}),
    autoOpenPreview: previewUrl !== "" && draft.autoOpenPreview,
    runOnWorktreeCreate: draft.runOnWorktreeCreate,
  }
}

function emptyDraft(): DraftScript {
  return {
    id: crypto.randomUUID(),
    name: "",
    command: "",
    hotkey: "",
    previewUrl: "",
    autoOpenPreview: false,
    runOnWorktreeCreate: false,
  }
}

function draftError(draft: DraftScript, all: DraftScript[]): string | null {
  if (draft.name.trim() === "") return "Name required"
  if (!isValidScriptCommand(draft.command)) {
    return 'Command required, must not start with "-"'
  }
  if (draft.hotkey !== "" && !isValidScriptHotkey(draft.hotkey)) {
    return "Hotkey must be a single digit 1–9"
  }
  if (
    draft.hotkey !== "" &&
    all.some((other) => other.id !== draft.id && other.hotkey === draft.hotkey)
  ) {
    return `Hotkey ${draft.hotkey} is already taken`
  }
  if (draft.previewUrl.trim() !== "" && !isValidPreviewUrl(draft.previewUrl)) {
    return "Preview URL must start with http:// or https://"
  }
  return null
}

export function ScriptsMenu({ scripts, onRun, onSave }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  return (
    <div className="scripts-menu">
      <button
        type="button"
        className="tb-btn"
        title="Project scripts — run a named command (⌘⌥1–9)"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        Actions ▾
      </button>
      {menuOpen ? (
        <>
          <div
            className="menu-backdrop"
            role="presentation"
            onClick={() => setMenuOpen(false)}
          />
          <div className="tb-menu scripts-list" role="menu">
            {scripts.length === 0 ? (
              <div className="scripts-none">No scripts yet</div>
            ) : (
              scripts.map((script) => (
                <button
                  key={script.id}
                  type="button"
                  role="menuitem"
                  className="scripts-item"
                  title={script.command}
                  onClick={() => {
                    setMenuOpen(false)
                    onRun(script)
                  }}
                >
                  <span className="scripts-item-name">{script.name}</span>
                  <span className="scripts-item-cmd">{script.command}</span>
                  {script.hotkey ? (
                    <span className="scripts-item-key">⌘⌥{script.hotkey}</span>
                  ) : null}
                </button>
              ))
            )}
            <button
              type="button"
              role="menuitem"
              className="scripts-item scripts-item-edit"
              onClick={() => {
                setMenuOpen(false)
                setEditorOpen(true)
              }}
            >
              Edit scripts…
            </button>
          </div>
        </>
      ) : null}
      {editorOpen ? (
        <ScriptsEditor
          scripts={scripts}
          onSave={onSave}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </div>
  )
}

function ScriptsEditor({
  scripts,
  onSave,
  onClose,
}: {
  scripts: ProjectScript[]
  onSave: (scripts: ProjectScript[]) => Promise<void>
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<DraftScript[]>(() => scripts.map(toDraft))
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const patch = (id: string, changes: Partial<DraftScript>) => {
    setDrafts((curr) =>
      curr.map((d) => (d.id === id ? { ...d, ...changes } : d)),
    )
  }

  const save = async () => {
    if (drafts.some((d) => draftError(d, drafts) !== null)) {
      setShowErrors(true)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(drafts.map(toScript))
      onClose()
    } catch (err) {
      setSaveError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel scripts-editor"
        role="dialog"
        aria-label="Edit project scripts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Project scripts</h2>
          <button
            type="button"
            className="icon-chip ghost"
            title="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-lead">
            Named commands for this project, shared via{" "}
            <code>.chathub/scripts.json</code>. They run in the Terminal surface;
            a preview URL can pull the Browser surface open, and worktree-create
            scripts run in every fresh worktree before the first turn.
          </p>
          {drafts.length === 0 ? (
            <div className="scripts-none">No scripts — add one below.</div>
          ) : null}
          {drafts.map((draft) => {
            const error = showErrors ? draftError(draft, drafts) : null
            return (
              <div key={draft.id} className="scripts-row">
                <div className="scripts-row-fields">
                  <input
                    className="text-input scripts-field-name"
                    value={draft.name}
                    placeholder="Name (e.g. Dev)"
                    onChange={(e) => patch(draft.id, { name: e.target.value })}
                  />
                  <input
                    className="text-input scripts-field-cmd"
                    value={draft.command}
                    placeholder="Command (e.g. pnpm dev)"
                    spellCheck={false}
                    onChange={(e) => patch(draft.id, { command: e.target.value })}
                  />
                  <input
                    className="text-input scripts-field-key"
                    value={draft.hotkey}
                    placeholder="1–9"
                    maxLength={1}
                    aria-label="Hotkey digit"
                    onChange={(e) => patch(draft.id, { hotkey: e.target.value.trim() })}
                  />
                  <button
                    type="button"
                    className="icon-chip ghost danger"
                    title="Delete script"
                    onClick={() =>
                      setDrafts((curr) => curr.filter((d) => d.id !== draft.id))
                    }
                  >
                    ×
                  </button>
                </div>
                <div className="scripts-row-fields">
                  <input
                    className="text-input scripts-field-url"
                    value={draft.previewUrl}
                    placeholder="Preview URL (e.g. http://localhost:5173)"
                    spellCheck={false}
                    onChange={(e) =>
                      patch(draft.id, { previewUrl: e.target.value })
                    }
                  />
                  <label className="scripts-toggle">
                    <input
                      type="checkbox"
                      checked={draft.autoOpenPreview}
                      disabled={draft.previewUrl.trim() === ""}
                      onChange={(e) =>
                        patch(draft.id, { autoOpenPreview: e.target.checked })
                      }
                    />
                    Open preview
                  </label>
                  <label className="scripts-toggle">
                    <input
                      type="checkbox"
                      checked={draft.runOnWorktreeCreate}
                      onChange={(e) =>
                        patch(draft.id, {
                          runOnWorktreeCreate: e.target.checked,
                        })
                      }
                    />
                    Run on worktree create
                  </label>
                </div>
                {error ? <div className="scripts-row-error">{error}</div> : null}
              </div>
            )
          })}
          <div className="scripts-editor-actions">
            <button
              type="button"
              className="tb-btn"
              onClick={() => setDrafts((curr) => [...curr, emptyDraft()])}
            >
              Add script
            </button>
            <div className="scripts-editor-spacer" />
            {saveError ? (
              <span className="scripts-row-error">{saveError}</span>
            ) : null}
            <button type="button" className="tb-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="tb-btn primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
