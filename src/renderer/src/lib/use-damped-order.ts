import { useEffect, useMemo, useState } from "react"
import { dampOrder, mergeMembership, type DampedOrder } from "./attention"

const SEP = "\u0000"

export function useDampedOrder(ids: readonly string[]): readonly string[] {
  const key = ids.join(SEP)
  const desired = useMemo(() => (key === "" ? [] : key.split(SEP)), [key])
  const [state, setState] = useState<DampedOrder>(() => ({
    order: desired,
    resortedAt: null,
  }))
  useEffect(() => {
    setState((prev) => dampOrder(prev, desired, Date.now()))
  }, [desired])
  return useMemo(() => {
    const merged = mergeMembership(state.order, desired)
    const settled =
      merged.length === state.order.length &&
      merged.every((id, index) => id === state.order[index])
    return settled ? state.order : merged
  }, [state.order, desired])
}
