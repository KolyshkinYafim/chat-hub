import { describe, expect, it } from "vitest"

import {
  MAX_TOASTS,
  dismissToast,
  pushToast,
  type Toast,
} from "../src/renderer/src/lib/toasts"

const make = (id: number, text = `toast ${id}`): Toast => ({ id, text })

describe("pushToast", () => {
  it("appends newest last", () => {
    const list = pushToast([make(1)], make(2))
    expect(list.map((t) => t.id)).toEqual([1, 2])
  })

  it("evicts the oldest beyond the cap", () => {
    let list: Toast[] = []
    for (let i = 1; i <= MAX_TOASTS + 2; i++) list = pushToast(list, make(i))
    expect(list).toHaveLength(MAX_TOASTS)
    expect(list.map((t) => t.id)).toEqual([3, 4, 5])
  })

  it("replaces a toast re-pushed with the same id instead of duplicating it", () => {
    const list = pushToast([make(1), make(2)], make(1, "updated"))
    expect(list.map((t) => t.id)).toEqual([2, 1])
    expect(list[1].text).toBe("updated")
  })
})

describe("dismissToast", () => {
  it("removes only the matching toast", () => {
    const list = dismissToast([make(1), make(2)], 1)
    expect(list.map((t) => t.id)).toEqual([2])
  })

  it("leaves the list alone for an unknown id", () => {
    const list = [make(1)]
    expect(dismissToast(list, 9)).toEqual(list)
  })
})
