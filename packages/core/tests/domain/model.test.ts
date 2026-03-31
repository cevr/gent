import { describe, test, expect } from "effect-bun-test"
import { calculateCost } from "@gent/core/domain/model"

describe("Cost Calculation", () => {
  test("calculateCost computes correctly", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    const pricing = { input: 3, output: 15 } // $3/1M input, $15/1M output

    const cost = calculateCost(usage, pricing)
    // (1000 / 1M) * 3 + (500 / 1M) * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6)
  })

  test("calculateCost returns 0 without pricing", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    expect(calculateCost(usage, undefined)).toBe(0)
  })

  test("calculateCost handles large token counts", () => {
    const usage = { inputTokens: 100000, outputTokens: 50000 }
    const pricing = { input: 3, output: 15 }

    const cost = calculateCost(usage, pricing)
    // (100000 / 1M) * 3 + (50000 / 1M) * 15 = 0.3 + 0.75 = 1.05
    expect(cost).toBeCloseTo(1.05, 6)
  })
})
