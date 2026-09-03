import { nativeTheme, type BrowserWindow } from "electron"
import type { CockpitVibrancy } from "@shared/cockpit"

export function prefersReducedTransparency(): boolean {
  return nativeTheme.prefersReducedTransparency === true
}

export function shouldGlass(enabled: boolean): boolean {
  return (
    enabled && process.platform === "darwin" && !prefersReducedTransparency()
  )
}

export function applyCockpitChrome(
  win: BrowserWindow,
  enabled: boolean,
  vibrancy: CockpitVibrancy,
  opaqueBackground: string,
): void {
  if (win.isDestroyed()) return
  const glass = shouldGlass(enabled)
  if (glass) {
    win.setBackgroundColor("#00000000")
    win.setVibrancy(vibrancy)
    return
  }
  if (process.platform === "darwin") win.setVibrancy(null)
  win.setBackgroundColor(opaqueBackground)
}

let watchingReducedTransparency = false

export function watchReducedTransparency(apply: () => void): void {
  if (watchingReducedTransparency) return
  watchingReducedTransparency = true
  nativeTheme.on("updated", apply)
}
