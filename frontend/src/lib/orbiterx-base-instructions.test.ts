import { describe, expect, it } from "vitest"
import {
  ORBITERX_BASE_INSTRUCTIONS,
  buildBaseInstructions,
  identityForModel,
} from "./orbiterx-base-instructions"

describe("orbiterx base instructions", () => {
  it("defaults to the deepseek-v4-flash persona", () => {
    expect(ORBITERX_BASE_INSTRUCTIONS).toContain(
      "You are OrbiterX Flash, an agent built on DeepSeek-V4-Flash."
    )
    expect(ORBITERX_BASE_INSTRUCTIONS).not.toContain("You are Codex")
    expect(ORBITERX_BASE_INSTRUCTIONS).not.toContain("led by OpenAI")
  })

  it("resolves per-model identities", () => {
    expect(identityForModel("deepseek-v4-flash")).toContain("OrbiterX Flash")
    expect(identityForModel("deepseek-v4-pro")).toContain("OrbiterX Pro")
    expect(identityForModel("kimi-k3")).toContain("Kimi K3")
    expect(identityForModel("gpt-5.6-sol")).toContain("OrbiterX Sol")
    expect(identityForModel("gpt-5.4-mini")).toContain("OrbiterX Mini")
  })

  it("falls back for unknown and gateway-suffixed models", () => {
    expect(identityForModel("kimi-k3-0717")).toContain("Kimi K3")
    expect(identityForModel("deepseek-v4-flash-2026")).toContain("OrbiterX Flash")
    expect(identityForModel("totally-unknown")).toContain("OrbiterX Flash")
    expect(identityForModel(null)).toContain("OrbiterX Flash")
  })

  it("swaps the personality section body", () => {
    expect(buildBaseInstructions("gpt-5.6-sol", "friendly")).toContain(
      "You optimize for team morale"
    )
    expect(buildBaseInstructions("gpt-5.6-sol", "pragmatic")).toContain(
      "You are a deeply pragmatic, effective software engineer."
    )
    expect(buildBaseInstructions("gpt-5.6-sol", "none")).toContain(
      "As OrbiterX, you are an excellent communicator"
    )
    // Unknown personalities fall back to the default persona.
    expect(buildBaseInstructions("gpt-5.6-sol", "bogus")).toContain(
      "As OrbiterX, you are an excellent communicator"
    )
  })

  it("keeps the load-bearing tool-calling rules", () => {
    expect(ORBITERX_BASE_INSTRUCTIONS).toContain("prefer parallelization over sequential")
    expect(ORBITERX_BASE_INSTRUCTIONS).toContain("Do not chain shell commands")
  })
})
