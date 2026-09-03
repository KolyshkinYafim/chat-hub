import { describe, expect, it } from "vitest"
import { titleBarOptions } from "../src/main/window-chrome"

describe("titleBarOptions", () => {
  it("hides the title bar behind the traffic lights on darwin", () => {
    expect(titleBarOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    })
  })

  it("keeps the native frame on linux", () => {
    expect(titleBarOptions("linux")).toEqual({})
  })

  it("keeps the native frame on win32", () => {
    expect(titleBarOptions("win32")).toEqual({})
  })
})
