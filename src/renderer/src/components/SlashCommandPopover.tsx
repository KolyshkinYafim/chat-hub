import type { SlashCommand } from "@shared/slash-commands"

type Props = {
  commands: SlashCommand[]
  query: string
  active: number
  onMove: (index: number) => void
  onPick: (cmd: SlashCommand) => void
}

/**
 * Skill / prompt completion above the composer. Keys are handled by the
 * textarea that owns the draft, so the popover only paints and takes clicks.
 */
export function SlashCommandPopover({ commands, query, active, onMove, onPick }: Props) {
  return (
    <div className="slash-popover" role="listbox" aria-label="Slash commands">
      {commands.length === 0 ? (
        <div className="slash-empty">
          No command matches <b>/{query}</b>
        </div>
      ) : (
        commands.map((cmd, i) => (
          <button
            key={`${cmd.source}:${cmd.name}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`slash-row ${i === active ? "on" : ""}`}
            onMouseEnter={() => onMove(i)}
            // mousedown, not click: the textarea must keep focus.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(cmd)
            }}
          >
            <span className="slash-name mono-soft">/{cmd.name}</span>
            <span className="slash-source">{cmd.source}</span>
            {cmd.description ? (
              <span className="slash-desc">{cmd.description}</span>
            ) : null}
          </button>
        ))
      )}
      <div className="slash-foot">
        <span className="kbd">↑↓</span> move
        <span className="kbd">⇥</span> complete
        <span className="kbd">esc</span> hide
      </div>
    </div>
  )
}
