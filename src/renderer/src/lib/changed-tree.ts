import { normalizePath } from "./path-match"

export type ChangedTreeFile = {
  path: string
  added?: number
  removed?: number
}

export type TreeNode = {
  kind: "dir" | "file"
  name: string
  path: string
  added: number
  removed: number
  children?: TreeNode[]
}

type DraftDir = {
  dirs: Map<string, DraftDir>
  files: Map<string, { added: number; removed: number }>
}

/** Folds a flat change list into a sorted tree, compacting single-child dir chains. */
export function buildChangedTree(files: ChangedTreeFile[]): TreeNode | null {
  const root = emptyDir()
  for (const file of files) {
    const segments = normalizePath(file.path).split("/").filter(Boolean)
    if (segments.length === 0) continue
    const name = segments.pop()!
    let dir = root
    for (const segment of segments) {
      let next = dir.dirs.get(segment)
      if (!next) {
        next = emptyDir()
        dir.dirs.set(segment, next)
      }
      dir = next
    }
    const counts = dir.files.get(name) ?? { added: 0, removed: 0 }
    counts.added += file.added ?? 0
    counts.removed += file.removed ?? 0
    dir.files.set(name, counts)
  }

  const children = childNodes(root, "")
  if (children.length === 0) return null
  return {
    kind: "dir",
    name: "",
    path: "",
    added: sum(children, "added"),
    removed: sum(children, "removed"),
    children,
  }
}

function emptyDir(): DraftDir {
  return { dirs: new Map(), files: new Map() }
}

function childNodes(dir: DraftDir, base: string): TreeNode[] {
  const dirs = [...dir.dirs.entries()].map(([name, draft]) =>
    dirNode(name, draft, base),
  )
  const files = [...dir.files.entries()].map(
    ([name, counts]): TreeNode => ({
      kind: "file",
      name,
      path: joinPath(base, name),
      added: counts.added,
      removed: counts.removed,
    }),
  )
  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name)
  return [...dirs.sort(byName), ...files.sort(byName)]
}

function dirNode(name: string, draft: DraftDir, base: string): TreeNode {
  let joined = name
  let dir = draft
  while (dir.files.size === 0 && dir.dirs.size === 1) {
    const [[next, deeper]] = [...dir.dirs.entries()] as [[string, DraftDir]]
    joined = `${joined}/${next}`
    dir = deeper
  }
  const path = joinPath(base, joined)
  const children = childNodes(dir, path)
  return {
    kind: "dir",
    name: joined,
    path,
    added: sum(children, "added"),
    removed: sum(children, "removed"),
    children,
  }
}

function joinPath(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`
}

function sum(nodes: TreeNode[], key: "added" | "removed"): number {
  return nodes.reduce((total, node) => total + node[key], 0)
}
