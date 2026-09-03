import type { BrowserWindowConstructorOptions } from "electron"

export type TitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
>

export function titleBarOptions(
  platform: NodeJS.Platform = process.platform,
): TitleBarOptions {
  if (platform !== "darwin") return {}
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
  }
}
