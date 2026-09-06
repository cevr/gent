import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { formatTokens } from "../src/utils/format-tool"

// ── Context window % computation (extracted logic) ───────────────────

type ContextPct = { pct: number; label: string; severity: "muted" | "warning" | "error" }

function computeContextPct(
  inputTokens: number,
  contextLength: Option.Option<number>,
): Option.Option<ContextPct> {
  if (inputTokens <= 0) return Option.none()
  return Option.map(contextLength, (length) => {
    const pct = Math.min(100, Math.round((inputTokens / length) * 100))
    let severity: ContextPct["severity"] = "muted"
    if (pct >= 90) severity = "error"
    else if (pct >= 70) severity = "warning"
    return { pct, label: `${formatTokens(inputTokens)} (${pct}%)`, severity }
  })
}

const absentContextPct: ContextPct = { pct: -1, label: "", severity: "muted" }
const requireContextPct = (inputTokens: number, contextLength: number): ContextPct =>
  Option.getOrElse(
    computeContextPct(inputTokens, Option.some(contextLength)),
    () => absentContextPct,
  )

describe("context window utilization", () => {
  test("0% when no tokens", () => {
    expect(Option.isNone(computeContextPct(0, Option.some(200000)))).toBe(true)
  })

  test("hidden when contextLength is absent", () => {
    expect(Option.isNone(computeContextPct(50000, Option.none()))).toBe(true)
  })

  test("50% — muted", () => {
    const result = requireContextPct(100000, 200000)
    expect(result.pct).toBe(50)
    expect(result.severity).toBe("muted")
    expect(result.label).toBe("100k (50%)")
  })

  test("70% threshold — warning", () => {
    const result = requireContextPct(140000, 200000)
    expect(result.pct).toBe(70)
    expect(result.severity).toBe("warning")
  })

  test("69% — still muted", () => {
    const result = requireContextPct(138000, 200000)
    expect(result.pct).toBe(69)
    expect(result.severity).toBe("muted")
  })

  test("90% threshold — error", () => {
    const result = requireContextPct(180000, 200000)
    expect(result.pct).toBe(90)
    expect(result.severity).toBe("error")
  })

  test("100% — clamped", () => {
    const result = requireContextPct(200000, 200000)
    expect(result.pct).toBe(100)
    expect(result.severity).toBe("error")
  })

  test("over 100% — clamped to 100", () => {
    const result = requireContextPct(250000, 200000)
    expect(result.pct).toBe(100)
  })

  test("small token count formats correctly", () => {
    const result = requireContextPct(500, 200000)
    expect(result.label).toBe("500 (0%)")
    expect(result.severity).toBe("muted")
  })

  test("large token count formats with M suffix", () => {
    const result = requireContextPct(1500000, 2000000)
    expect(result.label).toBe("1.5M (75%)")
    expect(result.severity).toBe("warning")
  })
})
