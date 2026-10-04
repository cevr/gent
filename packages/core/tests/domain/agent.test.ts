import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  cacheWriteRate,
  calculateCost,
  DriverRef,
  effectiveModelDriver,
  ModelId,
  parseModelId,
  ProviderId,
  RunSpecSchema,
} from "../../src/domain/agent"

// ── agent driver routing ────────────────────────────────────────────────────

/**
 * effectiveModelDriver — the one derivation of driver id and catalog model id.
 * The precedence between an agent's driver and a config override is
 * `resolveSessionRoute`'s, tested in tests/runtime/turn.test.ts.
 */

describe("effective model driver", () => {
  const modelId = ModelId.make("anthropic/claude-sonnet-5")
  const absentDriver = Option.none<DriverRef>()

  test("no driver routes by the provider segment and keeps the model id", () => {
    const result = effectiveModelDriver(absentDriver, modelId)
    expect(result.driverId).toEqual(Option.some("anthropic"))
    expect(result.contextModelId).toBe(modelId)
  })

  test("a model driver override replaces the provider segment in the context model id", () => {
    const result = effectiveModelDriver(
      Option.some(DriverRef.make({ id: "anthropic-proxy" })),
      modelId,
    )
    expect(result.driverId).toEqual(Option.some("anthropic-proxy"))
    expect(result.contextModelId).toBe(ModelId.make("anthropic-proxy/claude-sonnet-5"))
  })

  test("a model driver without an id falls back to the provider segment", () => {
    const result = effectiveModelDriver(Option.some(DriverRef.make({})), modelId)
    expect(result.driverId).toEqual(Option.some("anthropic"))
    expect(result.contextModelId).toBe(modelId)
  })

  test("an unparseable model id yields no driver and an unchanged context model id", () => {
    const bare = ModelId.make("claude-sonnet-5")
    const result = effectiveModelDriver(
      Option.some(DriverRef.make({ id: "anthropic-proxy" })),
      bare,
    )
    expect(result.driverId).toEqual(Option.some("anthropic-proxy"))
    expect(result.contextModelId).toBe(bare)
    expect(effectiveModelDriver(absentDriver, bare).driverId).toEqual(Option.none())
  })
})

// ── run spec ────────────────────────────────────────────────────────────────

describe("run spec", () => {
  test("a stored run spec that still carries the dropped parentToolCallId decodes", () => {
    const decoded = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))(
      '{"overrides":{"maxModelAttempts":32},"parentToolCallId":"tc-old"}',
    )
    expect(decoded).toEqual({ overrides: { maxModelAttempts: 32 } })
  })

  // Rows written before `tools` carry the two lists and `modelId`; each
  // decodes into the one pattern list and `model`, and encodes in the new shape.
  test("a stored run spec with the old tool lists decodes into tool patterns", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))
    expect(
      decode('{"overrides":{"modelId":"openai/gpt-5","allowedTools":["read","film.look"]}}'),
    ).toEqual({ overrides: { model: ModelId.make("openai/gpt-5"), tools: ["read", "film.look"] } })
    expect(decode('{"overrides":{"deniedTools":["delegate.start","bash"]}}')).toEqual({
      overrides: { tools: ["*", "!delegate.start", "!bash"] },
    })
    expect(decode('{"overrides":{"allowedTools":["read","bash"],"deniedTools":["bash"]}}')).toEqual(
      { overrides: { tools: ["read", "bash", "!bash"] } },
    )
    const migrated = decode('{"overrides":{"modelId":"a/b","deniedTools":["bash"]}}')
    expect(Schema.encodeSync(Schema.fromJsonString(RunSpecSchema))(migrated)).toBe(
      '{"overrides":{"model":"a/b","tools":["*","!bash"]}}',
    )
  })

  test("a run spec that names tools keeps them over the old lists", () => {
    const decoded = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))(
      '{"overrides":{"tools":["read"],"deniedTools":["read"],"model":"a/b","modelId":"c/d"}}',
    )
    expect(decoded).toEqual({ overrides: { tools: ["read"], model: ModelId.make("a/b") } })
  })
})

// ── model ids ───────────────────────────────────────────────────────────────

describe("model id parsing", () => {
  test("extracts provider and model segments", () => {
    expect(parseModelId("anthropic/claude-sonnet")).toEqual(
      Option.some([ProviderId.make("anthropic"), "claude-sonnet"]),
    )
  })

  test("rejects missing provider or model segment", () => {
    expect(parseModelId("anthropic")).toEqual(Option.none())
    expect(parseModelId("/claude-sonnet")).toEqual(Option.none())
    expect(parseModelId("anthropic/")).toEqual(Option.none())
  })
})

describe("step cost", () => {
  // One live Sonnet 5 step: 13,486 input tokens, 13,462 of them read from the cache.
  const usage = {
    inputTokens: 13_486,
    outputTokens: 5,
    cacheReadTokens: 13_462,
    cacheWriteTokens: 22,
  }

  test("cache reads and writes take their own price", () => {
    const cost = calculateCost(
      usage,
      Option.some({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
    )
    expect(cost).toBeCloseTo((2 * 2 + 13_462 * 0.2 + 22 * 2.5 + 5 * 10) / 1_000_000, 12)
  })

  test("a price without cache rates charges every input token at the input price", () => {
    const cost = calculateCost(usage, Option.some({ input: 2, output: 10 }))
    expect(cost).toBeCloseTo((13_486 * 2 + 5 * 10) / 1_000_000, 12)
  })

  test("no price costs nothing", () => {
    expect(calculateCost(usage, Option.none())).toBe(0)
  })

  // Anthropic prices a 5-minute write at 1.25x input and a 1-hour write at 2x.
  const byLifetime = {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 4,
    cacheWriteByLifetime: [{ ttlMs: 300_000, price: 2.5 }],
  }
  const writes = (ttlMs: number, tokens: number) => ({
    inputTokens: 1000,
    outputTokens: 0,
    cacheWriteTokens: 1000,
    cacheWritesByLifetime: [{ ttlMs, tokens }],
  })

  test("a write split by lifetime takes its lifetime's rate, the rest takes cacheWrite", () => {
    const cost = calculateCost(writes(300_000, 600), Option.some(byLifetime))
    expect(cost).toBeCloseTo((600 * 2.5 + 400 * 4) / 1_000_000, 12)
  })

  test("a lifetime the catalog does not price takes cacheWrite", () => {
    const cost = calculateCost(writes(3_600_000, 1000), Option.some(byLifetime))
    expect(cost).toBeCloseTo((1000 * 4) / 1_000_000, 12)
  })

  test("the write rate reads the lifetime's rate, then cacheWrite, then input", () => {
    expect(cacheWriteRate(byLifetime, Option.some(300_000))).toBe(2.5)
    expect(cacheWriteRate(byLifetime, Option.some(3_600_000))).toBe(4)
    expect(cacheWriteRate(byLifetime, Option.none())).toBe(4)
    expect(cacheWriteRate({ input: 2, output: 10 }, Option.some(300_000))).toBe(2)
  })
})
