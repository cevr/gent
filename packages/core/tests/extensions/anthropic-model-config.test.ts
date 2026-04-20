/**
 * Per-model Anthropic configuration — beta lists + ccVersion + override
 * table. Counsel C8 — locks the port of
 * `griffinmartin/opencode-claude-auth/src/model-config.ts` so future
 * version bumps + override edits stay aligned with Claude Code's wire
 * shape.
 */
import { describe, test, expect } from "bun:test"
import {
  getCcVersion,
  getModelBetas,
  getModelOverride,
  MODEL_CONFIG,
  supports1mContext,
} from "@gent/extensions/anthropic/model-config"

describe("MODEL_CONFIG", () => {
  test("ccVersion is the currently-advertised Claude Code CLI version", () => {
    // Reference: opencode-claude-auth/src/model-config.ts:15
    expect(MODEL_CONFIG.ccVersion).toBe("2.1.90")
    expect(getCcVersion()).toBe(MODEL_CONFIG.ccVersion)
  })

  test("baseBetas carry the five flags Claude Code currently sends", () => {
    // Lock the exact set so a missed reference-impl update fails
    // loudly in CI rather than silently drifting from the wire shape.
    expect([...MODEL_CONFIG.baseBetas]).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "prompt-caching-scope-2026-01-05",
      "context-management-2025-06-27",
    ])
  })

  test("longContextBetas include the 1M-context flag first", () => {
    expect(MODEL_CONFIG.longContextBetas[0]).toBe("context-1m-2025-08-07")
  })
})

describe("getModelOverride", () => {
  test("haiku family disables effort and excludes interleaved-thinking", () => {
    const override = getModelOverride("claude-haiku-4-5")
    expect(override?.disableEffort).toBe(true)
    expect(override?.exclude).toContain("interleaved-thinking-2025-05-14")
  })

  test("4-6 models add the effort beta", () => {
    const override = getModelOverride("claude-sonnet-4-6")
    expect(override?.add).toContain("effort-2025-11-24")
  })

  test("4-7 models add the effort beta", () => {
    const override = getModelOverride("claude-opus-4-7")
    expect(override?.add).toContain("effort-2025-11-24")
  })

  test("returns undefined for models matching no override pattern", () => {
    expect(getModelOverride("claude-sonnet-3-5")).toBeUndefined()
  })

  test("matches case-insensitively", () => {
    const override = getModelOverride("CLAUDE-HAIKU-4-5")
    expect(override?.disableEffort).toBe(true)
  })
})

describe("supports1mContext", () => {
  test("opus 4.6+ supports 1m", () => {
    expect(supports1mContext("claude-opus-4-6")).toBe(true)
    expect(supports1mContext("claude-opus-4-7")).toBe(true)
    expect(supports1mContext("claude-opus-5-0")).toBe(true)
  })

  test("sonnet 4.6+ supports 1m", () => {
    expect(supports1mContext("claude-sonnet-4-6")).toBe(true)
    expect(supports1mContext("claude-sonnet-5-0")).toBe(true)
  })

  test("opus/sonnet below 4.6 does not", () => {
    expect(supports1mContext("claude-opus-4-5")).toBe(false)
    expect(supports1mContext("claude-sonnet-3-5")).toBe(false)
  })

  test("haiku is not eligible regardless of version", () => {
    expect(supports1mContext("claude-haiku-4-7")).toBe(false)
  })

  test("date-suffix model ids are treated as x.0 (not x.<N>)", () => {
    // Counsel C8 — date suffix like 20250514 reads minor>99 → effective 0,
    // so opus-4-20250514 is treated as 4.0 (not 1m-eligible).
    expect(supports1mContext("claude-opus-4-20250514")).toBe(false)
  })
})

describe("getModelBetas", () => {
  test("includes every base beta for a generic sonnet model", () => {
    const betas = getModelBetas("claude-sonnet-4-5", undefined)
    for (const beta of MODEL_CONFIG.baseBetas) {
      expect(betas).toContain(beta)
    }
  })

  test("opus 4.6+ also gets the long-context beta", () => {
    const betas = getModelBetas("claude-opus-4-6", undefined)
    expect(betas).toContain("context-1m-2025-08-07")
    // Plus the 4-6 override adds the effort beta.
    expect(betas).toContain("effort-2025-11-24")
  })

  test("haiku omits interleaved-thinking (excluded by override)", () => {
    const betas = getModelBetas("claude-haiku-4-5", undefined)
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    // baseBetas minus the excluded one.
    expect(betas).toContain("claude-code-20250219")
    expect(betas).toContain("oauth-2025-04-20")
  })

  test("env override replaces the base list comma-split", () => {
    const betas = getModelBetas("claude-sonnet-4-5", "alpha,beta,gamma")
    expect(betas).toEqual(["alpha", "beta", "gamma"])
  })

  test("excluded set drops the listed betas (long-context backoff path)", () => {
    const betas = getModelBetas("claude-opus-4-6", undefined, new Set(["context-1m-2025-08-07"]))
    expect(betas).not.toContain("context-1m-2025-08-07")
    // Other betas survive.
    expect(betas).toContain("oauth-2025-04-20")
  })

  test("does not duplicate add-overrides already present in the base list", () => {
    // Simulate an env that already includes the override-added beta.
    const betas = getModelBetas("claude-sonnet-4-6", "claude-code-20250219,effort-2025-11-24")
    const occurrences = betas.filter((b) => b === "effort-2025-11-24").length
    expect(occurrences).toBe(1)
  })
})
