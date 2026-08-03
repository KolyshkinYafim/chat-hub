import type { SurfaceKind } from "../../lib/surface-bridge"

const PATHS: Record<SurfaceKind, string> = {
  browser: "M2.5 5.5h11M4.5 3.6v.01M6.4 3.6v.01M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z",
  terminal: "M1.5 3.5h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM4 6.5 6 8l-2 1.5M8 9.5h4",
  files: "M1.5 4.2a1 1 0 0 1 1-1h3.1l1.4 1.6h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.2Z",
  diff: "M4 2.5v11M12 2.5v11M2 5.5h4M2 8h4M9.5 7.5h5M12 5v5",
}

export function SurfaceIcon({ kind }: { kind: SurfaceKind }) {
  return (
    <svg
      className="surface-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[kind]} />
    </svg>
  )
}

export function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="surface-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.75" width="13" height="10.5" rx="1.6" />
      <path d="M10 2.75v10.5" />
      {open ? (
        <rect
          x="10"
          y="2.75"
          width="4.5"
          height="10.5"
          rx="1.6"
          fill="currentColor"
          stroke="none"
          opacity="0.5"
        />
      ) : null}
    </svg>
  )
}
