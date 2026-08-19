import { useMemo, useState } from "react"
import { extensionOf } from "@shared/file-kind"
import { buildChangedTree, type TreeNode } from "../lib/changed-tree"
import { displayPath } from "../lib/path-match"
import type { ChangedFiles as Changed } from "../lib/tool-runs"

const BADGE_TONES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  yml: "json",
  yaml: "json",
  toml: "json",
  md: "md",
  mdx: "md",
  txt: "md",
  png: "img",
  jpg: "img",
  jpeg: "img",
  gif: "img",
  svg: "img",
  webp: "img",
  ico: "img",
  html: "html",
  htm: "html",
  xml: "html",
  vue: "html",
}

function badge(path: string): { label: string; tone: string } {
  const ext = extensionOf(path)
  return {
    label: (ext || "file").slice(0, 4).toUpperCase(),
    tone: BADGE_TONES[ext] ?? "plain",
  }
}

function dirPathsOf(node: TreeNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.kind === "dir") {
      out.push(child.path)
      dirPathsOf(child, out)
    }
  }
  return out
}

export function ChangedFiles({
  changed,
  cwd,
  onOpenDiff,
}: {
  changed: Changed
  cwd?: string
  onOpenDiff?: (path: string) => void
}) {
  const { files, added, removed, countsKnown } = changed
  const tree = useMemo(
    () =>
      buildChangedTree(
        files.map((file) => ({ ...file, path: displayPath(cwd, file.path) })),
      ),
    [files, cwd],
  )
  const originals = useMemo(() => {
    const map = new Map<string, string>()
    for (const file of files) map.set(displayPath(cwd, file.path), file.path)
    return map
  }, [files, cwd])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  if (!tree) return null

  const dirPaths = dirPathsOf(tree)
  const allCollapsed =
    dirPaths.length > 0 && dirPaths.every((path) => collapsed[path])

  const toggleAll = () => {
    if (allCollapsed) {
      setCollapsed({})
      return
    }
    setCollapsed(Object.fromEntries(dirPaths.map((path) => [path, true])))
  }

  const openFile = (path: string) => {
    onOpenDiff?.(originals.get(path) ?? path)
  }

  return (
    <div className="changed-files">
      <div className="changed-head">
        <span className="changed-count">
          Changed files ({files.length})
          {countsKnown ? (
            <span className="changed-total">
              {" · "}
              <span className="diff-stat add">+{added}</span>/
              <span className="diff-stat del">−{removed}</span>
            </span>
          ) : null}
        </span>
        <span className="changed-actions">
          {dirPaths.length > 0 ? (
            <button type="button" className="changed-action" onClick={toggleAll}>
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          ) : null}
          {onOpenDiff ? (
            <button
              type="button"
              className="changed-action"
              title="Open the Diff panel"
              onClick={() => onOpenDiff("")}
            >
              View diff
            </button>
          ) : null}
        </span>
      </div>
      <ul className="chtree" role="tree">
        {tree.children!.map((node) => (
          <TreeRows
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            countsKnown={countsKnown}
            onToggle={(path) =>
              setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
            }
            onOpen={openFile}
          />
        ))}
      </ul>
    </div>
  )
}

function TreeRows({
  node,
  depth,
  collapsed,
  countsKnown,
  onToggle,
  onOpen,
}: {
  node: TreeNode
  depth: number
  collapsed: Record<string, boolean>
  countsKnown: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const indent = { paddingLeft: `${8 + depth * 16}px` }
  const delta = countsKnown ? (
    <span className="chtree-delta">
      <span className="diff-stat add">+{node.added}</span>
      <span className="diff-stat del">−{node.removed}</span>
    </span>
  ) : null

  if (node.kind === "file") {
    const { label, tone } = badge(node.path)
    return (
      <li role="treeitem">
        <button
          type="button"
          className="chtree-row chtree-file"
          style={indent}
          title={`${node.path} — open in the Diff panel`}
          onClick={() => onOpen(node.path)}
        >
          <span className={`chtree-badge tone-${tone}`}>{label}</span>
          <span className="chtree-name">{node.name}</span>
          {delta}
        </button>
      </li>
    )
  }

  const shut = collapsed[node.path] === true
  return (
    <li role="treeitem" aria-expanded={!shut}>
      <button
        type="button"
        className="chtree-row chtree-dir"
        style={indent}
        onClick={() => onToggle(node.path)}
      >
        <span className={`chtree-caret ${shut ? "shut" : ""}`}>▾</span>
        <span className="chtree-name">{node.name}</span>
        {delta}
      </button>
      {shut ? null : (
        <ul className="chtree-branch" role="group">
          {node.children!.map((child) => (
            <TreeRows
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              countsKnown={countsKnown}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
