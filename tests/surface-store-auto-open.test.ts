import { describe, expect, it } from "vitest"
import { shouldAutoOpenDock } from "../src/renderer/src/lib/surface-store"

describe("shouldAutoOpenDock", () => {
  it("opens to diff when the dock is closed and a file was touched", () => {
    expect(
      shouldAutoOpenDock({ showDock: false, activeSurface: null }, ["/a.ts"]),
    ).toBe("diff")
  })

  it("does nothing when no files were touched", () => {
    expect(
      shouldAutoOpenDock({ showDock: false, activeSurface: null }, []),
    ).toBeNull()
  })

  it("switches files -> diff when the dock is already open", () => {
    expect(
      shouldAutoOpenDock(
        { showDock: true, activeSurface: "files" },
        ["/a.ts"],
      ),
    ).toBe("diff")
  })

  it("stays on diff without flicker when already showing diff", () => {
    expect(
      shouldAutoOpenDock({ showDock: true, activeSurface: "diff" }, ["/a.ts"]),
    ).toBe("diff")
  })

  it("never steals a surface the user deliberately picked", () => {
    for (const activeSurface of ["board", "browser", "terminal"] as const) {
      expect(
        shouldAutoOpenDock({ showDock: true, activeSurface }, ["/a.ts"]),
      ).toBeNull()
    }
  })

  it("respects the auto-open-disabled escape hatch", () => {
    expect(
      shouldAutoOpenDock(
        { showDock: false, activeSurface: null },
        ["/a.ts"],
        false,
      ),
    ).toBeNull()
  })
})
