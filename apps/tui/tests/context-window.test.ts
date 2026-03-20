import { describe, test, expect } from "bun:test"
import { formatTokens } from "../src/utils/format-tool"

// ── Context window % computation (extracted logic) ───────────────────

function computeContextPct(
  inputTokens: number,
  contextLength: number | undefined,
): { pct: number; label: string; severity: "muted" | "warning" | "error" } | null {
  if (inputTokens <= 0 || contextLength === undefined) return null
  const pct = Math.min(100, Math.round((inputTokens / contextLength) * 100))
  const severity = pct >= 90 ? "error" : pct >= 70 ? "warning" : "muted"
  return { pct, label: `${formatTokens(inputTokens)} (${pct}%)`, severity }
}

describe("context window utilization", () => {
  test("0% when no tokens", () => {
    expect(computeContextPct(0, 200000)).toBeNull()
  })

  test("hidden when contextLength undefined", () => {
    expect(computeContextPct(50000, undefined)).toBeNull()
  })

  test("50% — muted", () => {
    const result = computeContextPct(100000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(50)
    expect(result!.severity).toBe("muted")
    expect(result!.label).toBe("100k (50%)")
  })

  test("70% threshold — warning", () => {
    const result = computeContextPct(140000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(70)
    expect(result!.severity).toBe("warning")
  })

  test("69% — still muted", () => {
    const result = computeContextPct(138000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(69)
    expect(result!.severity).toBe("muted")
  })

  test("90% threshold — error", () => {
    const result = computeContextPct(180000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(90)
    expect(result!.severity).toBe("error")
  })

  test("100% — clamped", () => {
    const result = computeContextPct(200000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(100)
    expect(result!.severity).toBe("error")
  })

  test("over 100% — clamped to 100", () => {
    const result = computeContextPct(250000, 200000)
    expect(result).not.toBeNull()
    expect(result!.pct).toBe(100)
  })

  test("small token count formats correctly", () => {
    const result = computeContextPct(500, 200000)
    expect(result).not.toBeNull()
    expect(result!.label).toBe("500 (0%)")
    expect(result!.severity).toBe("muted")
  })

  test("large token count formats with M suffix", () => {
    const result = computeContextPct(1500000, 2000000)
    expect(result).not.toBeNull()
    expect(result!.label).toBe("1.5M (75%)")
    expect(result!.severity).toBe("warning")
  })
})
