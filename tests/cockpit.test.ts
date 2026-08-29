import { describe, expect, it } from "vitest"
import {
  parseCockpitEnabled,
  parseCockpitFlags,
  parseCockpitSearch,
  parseCockpitVibrancy,
  withCockpitArg,
  withCockpitVibrancyArg,
} from "@shared/cockpit"

describe("parseCockpitEnabled", () => {
  it("reads the env var when no argv override is present", () => {
    expect(parseCockpitEnabled([], {})).toBe(false)
    expect(parseCockpitEnabled([], { CHAT_HUB_COCKPIT: "1" })).toBe(true)
    expect(parseCockpitEnabled([], { CHAT_HUB_COCKPIT: "0" })).toBe(false)
  })

  it("lets argv override the env var", () => {
    expect(
      parseCockpitEnabled(["--chat-hub-cockpit=0"], { CHAT_HUB_COCKPIT: "1" }),
    ).toBe(false)
    expect(
      parseCockpitEnabled(["--chat-hub-cockpit=1"], { CHAT_HUB_COCKPIT: "0" }),
    ).toBe(true)
    expect(parseCockpitEnabled(["--chat-hub-cockpit"], {})).toBe(true)
  })
})

describe("parseCockpitVibrancy", () => {
  it("defaults to under-window and accepts hud", () => {
    expect(parseCockpitVibrancy([], {})).toBe("under-window")
    expect(parseCockpitVibrancy([], { CHAT_HUB_COCKPIT_VIBRANCY: "hud" })).toBe(
      "hud",
    )
    expect(
      parseCockpitVibrancy(["--chat-hub-cockpit-vibrancy=hud"], {
        CHAT_HUB_COCKPIT_VIBRANCY: "under-window",
      }),
    ).toBe("hud")
  })
})

describe("parseCockpitSearch", () => {
  it("reads the renderer query string", () => {
    expect(parseCockpitSearch("")).toEqual({
      enabled: false,
      vibrancy: "under-window",
    })
    expect(parseCockpitSearch("?cockpit=1&vibrancy=hud")).toEqual({
      enabled: true,
      vibrancy: "hud",
    })
  })
})

describe("parseCockpitFlags", () => {
  it("combines enablement and vibrancy", () => {
    expect(
      parseCockpitFlags(["--chat-hub-cockpit=1"], {
        CHAT_HUB_COCKPIT_VIBRANCY: "hud",
      }),
    ).toEqual({ enabled: true, vibrancy: "hud" })
  })
})

describe("relaunch args", () => {
  it("replaces a previous cockpit flag", () => {
    expect(withCockpitArg([".", "--chat-hub-cockpit=1"], false)).toEqual([
      ".",
      "--chat-hub-cockpit=0",
    ])
    expect(
      withCockpitVibrancyArg(
        withCockpitArg([".", "--chat-hub-cockpit-vibrancy=hud"], true),
        "under-window",
      ),
    ).toEqual([
      ".",
      "--chat-hub-cockpit=1",
      "--chat-hub-cockpit-vibrancy=under-window",
    ])
  })
})
