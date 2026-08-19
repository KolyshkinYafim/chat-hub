import { describe, expect, it } from "vitest"
import {
  composerSummary,
  modelLabel,
} from "../src/renderer/src/lib/composer-summary"

const MODELS = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
]

describe("modelLabel", () => {
  it("shows the probed label for a known model", () => {
    expect(modelLabel("fable", MODELS)).toBe("Fable (latest)")
  })

  it("names an unset model as the CLI default", () => {
    expect(modelLabel(undefined, MODELS)).toBe("CLI default")
    expect(modelLabel("", MODELS)).toBe("CLI default")
  })

  it("marks a model the probe does not know", () => {
    expect(modelLabel("claude-x", MODELS)).toBe("claude-x · not probed")
  })
})

describe("composerSummary", () => {
  it("joins model and effort when effort is supported", () => {
    expect(
      composerSummary({
        model: "fable",
        models: MODELS,
        effort: "high",
        supportsEffort: true,
      }),
    ).toBe("Fable (latest) · High")
  })

  it("drops effort for providers without an effort control", () => {
    expect(
      composerSummary({
        model: undefined,
        models: MODELS,
        effort: "medium",
        supportsEffort: false,
      }),
    ).toBe("CLI default")
  })
})
