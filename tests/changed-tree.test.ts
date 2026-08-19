import { describe, expect, it } from "vitest"
import {
  buildChangedTree,
  type TreeNode,
} from "@renderer/lib/changed-tree"

function child(node: TreeNode, name: string): TreeNode {
  const found = node.children?.find((c) => c.name === name)
  if (!found) throw new Error(`no child named ${name}`)
  return found
}

describe("building the changed-files tree", () => {
  it("returns null for an empty change set", () => {
    expect(buildChangedTree([])).toBeNull()
  })

  it("compacts a lone single-child directory chain into one node", () => {
    const tree = buildChangedTree([
      { path: "src/lib/constants.ts", added: 3, removed: 1 },
    ])!
    expect(tree.children).toHaveLength(1)
    const dir = child(tree, "src/lib")
    expect(dir).toMatchObject({
      kind: "dir",
      path: "src/lib",
      added: 3,
      removed: 1,
    })
    expect(dir.children).toHaveLength(1)
    expect(dir.children![0]).toMatchObject({
      kind: "file",
      name: "constants.ts",
      path: "src/lib/constants.ts",
    })
  })

  it("keeps a directory whole when it has more than one child", () => {
    const tree = buildChangedTree([
      { path: "src/lib/a.ts", added: 1, removed: 0 },
      { path: "src/pages/b.ts", added: 1, removed: 0 },
    ])!
    const src = child(tree, "src")
    expect(src.children!.map((c) => c.name)).toEqual(["lib", "pages"])
  })

  it("stops compacting where a file sits beside the chain", () => {
    const tree = buildChangedTree([
      { path: "src/lib/deep/a.ts", added: 1, removed: 0 },
      { path: "src/lib/index.ts", added: 1, removed: 0 },
    ])!
    const lib = child(tree, "src/lib")
    expect(lib.children!.map((c) => c.name)).toEqual(["deep", "index.ts"])
  })

  it("sums duplicate paths into a single file node", () => {
    const tree = buildChangedTree([
      { path: "src/app.ts", added: 4, removed: 2 },
      { path: "src/app.ts", added: 3, removed: 1 },
    ])!
    const src = child(tree, "src")
    expect(src.children).toHaveLength(1)
    expect(src.children![0]).toMatchObject({
      name: "app.ts",
      added: 7,
      removed: 3,
    })
  })

  it("rolls subtree counts up into every directory above", () => {
    const tree = buildChangedTree([
      { path: "src/lib/a.ts", added: 5, removed: 2 },
      { path: "src/pages/b.ts", added: 10, removed: 4 },
      { path: "package.json", added: 1, removed: 1 },
    ])!
    expect(tree).toMatchObject({ added: 16, removed: 7 })
    const src = child(tree, "src")
    expect(src).toMatchObject({ added: 15, removed: 6 })
    expect(child(src, "lib")).toMatchObject({ added: 5, removed: 2 })
  })

  it("sorts directories before files and alphabetically within each kind", () => {
    const tree = buildChangedTree([
      { path: "zeta.ts", added: 0, removed: 0 },
      { path: "beta/x.ts", added: 0, removed: 0 },
      { path: "alpha.ts", added: 0, removed: 0 },
      { path: "delta/y.ts", added: 0, removed: 0 },
    ])!
    expect(tree.children!.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "dir:beta",
      "dir:delta",
      "file:alpha.ts",
      "file:zeta.ts",
    ])
  })

  it("seats root-level files beside directories", () => {
    const tree = buildChangedTree([
      { path: "src/app.ts", added: 1, removed: 0 },
      { path: "package.json", added: 2, removed: 2 },
    ])!
    expect(tree.children!.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "dir:src",
      "file:package.json",
    ])
  })

  it("treats missing counts as zero", () => {
    const tree = buildChangedTree([{ path: "src/app.ts" }])!
    expect(child(tree, "src")).toMatchObject({ added: 0, removed: 0 })
  })
})
