import { describe, expect, test } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, Option, Result, Schema, SchemaIssue } from "effect"
import {
  AgentDefinition,
  AgentName,
  cacheWriteRate,
  calculateCost,
  DriverRef,
  effectiveModelDriver,
  ModelId,
  parseModelId,
  ProviderId,
  resolveSessionAgent,
  RunSpecSchema,
  StoredAgentDefinition,
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

  test("a run spec that names tools keeps them over the old lists", () => {
    const decoded = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))(
      '{"overrides":{"tools":["read"],"deniedTools":["read"],"model":"a/b","modelId":"c/d"}}',
    )
    expect(decoded).toEqual({ overrides: { tools: ["read"], model: ModelId.make("a/b") } })
  })
})

// ── the previous gent ───────────────────────────────────────────────────────

/**
 * The run spec and agent shapes as the previous gent reads them (the base of
 * the `tools` change): a test fixture, so a row or a reply written now is
 * read here the way an older process or client reads it.
 */
const PreviousRunOverrides = Schema.Struct({
  modelId: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  reasoningEffort: Schema.optional(Schema.String),
  contextLength: Schema.optional(Schema.Finite),
  maxSteps: Schema.optional(Schema.Finite),
  maxModelAttempts: Schema.optional(Schema.Finite),
  systemPromptAddendum: Schema.optional(Schema.String),
})
const PreviousRunSpec = Schema.Struct({ overrides: Schema.optional(PreviousRunOverrides) })
const PreviousAgentDefinition = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
})

/** The previous gent's `admitsTool` over its two lists. */
const previousAdmits = (
  lists: {
    readonly allowedTools?: ReadonlyArray<string>
    readonly deniedTools?: ReadonlyArray<string>
  },
  id: string,
) =>
  Option.match(Option.fromUndefinedOr(lists.allowedTools), {
    onNone: () => true,
    onSome: (allowed) => allowed.includes(id),
  }) &&
  !Option.getOrElse(
    Option.fromUndefinedOr(lists.deniedTools),
    (): ReadonlyArray<string> => [],
  ).includes(id)

const writeRunSpec = Schema.encodeSync(Schema.fromJsonString(RunSpecSchema))
const readRunSpec = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))
const readInPrevious = Schema.decodeSync(Schema.fromJsonString(PreviousRunSpec))

/** A run's overrides as the previous gent reads what this gent wrote. */
const previousOverrides = (
  overrides: (typeof RunSpecSchema.Type)["overrides"],
): typeof PreviousRunOverrides.Type =>
  Option.getOrElse(
    Option.fromUndefinedOr(readInPrevious(writeRunSpec({ overrides })).overrides),
    () => ({}),
  )

describe("a run spec the previous gent reads", () => {
  test("the model and the tool patterns it can express keep their meaning", () => {
    const model = ModelId.make("test/chosen")
    expect(previousOverrides({ model, tools: ["read", "bash"] })).toEqual({
      modelId: "test/chosen",
      allowedTools: ["read", "bash"],
    })
    expect(previousOverrides({ tools: ["*", "!bash"] })).toEqual({ deniedTools: ["bash"] })
    expect(previousOverrides({ tools: ["read", "bash", "!bash"] })).toEqual({
      allowedTools: ["read", "bash"],
      deniedTools: ["bash"],
    })
    expect(previousOverrides({ tools: [] })).toEqual({ allowedTools: [] })
  })

  // A wildcard the previous gent cannot read becomes an empty allow list:
  // the old reader holds no tool rather than every tool.
  test("a pattern the previous gent cannot express leaves it no tool", () => {
    for (const tools of [["film.*"], ["*", "!film.*"], ["!bash", "read"], ["read", "!x", "bash"]]) {
      const read = previousOverrides({ tools })
      expect(["read", "bash", "film.look"].filter((id) => previousAdmits(read, id))).toEqual([])
    }
  })

  test("an old row reads back out as the lists it was read from", () => {
    for (const row of [
      '{"overrides":{"modelId":"a/b","deniedTools":["bash"]}}',
      '{"overrides":{"allowedTools":["read","bash"]}}',
    ]) {
      expect(readInPrevious(writeRunSpec(readRunSpec(row)))).toEqual(readInPrevious(row))
    }
  })

  test("a definition a client of the previous gent reads keeps its model and tool lists", () => {
    const write = Schema.encodeSync(Schema.fromJsonString(StoredAgentDefinition))
    const read = Schema.decodeSync(Schema.fromJsonString(PreviousAgentDefinition))
    const painter = AgentDefinition.make({
      name: AgentName.make("painter"),
      model: ModelId.make("test/painter"),
      tools: ["film.look", "read", "!bash"],
    })
    expect(read(write(painter))).toEqual({
      name: "painter",
      model: "test/painter",
      allowedTools: ["film.look", "read"],
      deniedTools: ["bash"],
    })
    // And this gent reads it back as it was.
    expect(Schema.decodeSync(Schema.fromJsonString(StoredAgentDefinition))(write(painter))).toEqual(
      painter,
    )
  })
})

// ── old tool lists ──────────────────────────────────────────────────────────

/** The agent `name` runs as under one agent and the run overrides a stored row holds. */
const runAs = (agent: AgentDefinition, row: string) =>
  resolveSessionAgent({
    agents: [agent],
    configAgents: Option.none(),
    name: agent.name,
    overrides: Option.fromUndefinedOr(readRunSpec(row).overrides),
  }).pipe(Option.getOrThrow)

describe("old tool lists", () => {
  const reader = AgentDefinition.make({
    name: AgentName.make("reader"),
    tools: ["read", "grep", "!bash"],
  })
  const held = (agent: AgentDefinition) =>
    ["read", "grep", "write", "bash"].filter((id) => agent.admitsTool(id))

  // A deny list alone took tools away from the ones the agent had.
  test("an old deny-only override keeps the tools the agent inherits", () => {
    expect(held(runAs(reader, '{"overrides":{"deniedTools":["grep"]}}'))).toEqual(["read"])
  })

  // An allow list alone replaced the agent's allow list and kept its denials.
  test("an old allow-only override keeps the denials the agent inherits", () => {
    expect(held(runAs(reader, '{"overrides":{"allowedTools":["read","write","bash"]}}'))).toEqual([
      "read",
      "write",
    ])
  })

  test("both old lists replace the agent's tools", () => {
    expect(
      held(
        runAs(reader, '{"overrides":{"allowedTools":["write","bash"],"deniedTools":["write"]}}'),
      ),
    ).toEqual(["bash"])
  })

  test("new tool patterns replace the agent's tools", () => {
    expect(held(runAs(reader, '{"overrides":{"tools":["*","!read"]}}'))).toEqual([
      "grep",
      "write",
      "bash",
    ])
  })
})

// ── agent paths ─────────────────────────────────────────────────────────────

describe("agent paths", () => {
  // A bare string is a write entry; an object without access is one too.
  test("a paths entry decodes with its access spelled out", () => {
    const decoded = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))(
      '{"overrides":{"paths":["films",{"path":"skill","access":"read"},{"path":"notes"}]}}',
    )
    expect(decoded.overrides?.paths).toEqual([
      { path: "films", access: "write" },
      { path: "skill", access: "read" },
      { path: "notes", access: "write" },
    ])
  })
})

describe("agent definition", () => {
  // An extension written before `tools`: TS code that is loaded unchecked.
  test("an agent built with the old tool lists fails and names them", () => {
    const old = {
      name: AgentName.make("painter"),
      allowedTools: ["film.look"],
      deniedTools: ["bash"],
    }
    expect(() => AgentDefinition.make(old)).toThrow(
      'AgentDefinition "painter" has keys the schema does not name: allowedTools, deniedTools',
    )
  })

  test("an agent built with new and an unknown key fails the same way", () => {
    const misspelled = { name: AgentName.make("painter"), toolz: ["read"] }
    expect(() => new AgentDefinition(misspelled)).toThrow(
      'AgentDefinition "painter" has keys the schema does not name: toolz',
    )
  })

  // The inherited constructors parse first, and a parse drops the key.
  test("makeOption refuses an agent with an old tool list", () => {
    const old = { name: AgentName.make("painter"), allowedTools: ["read"] }
    expect(AgentDefinition.makeOption(old)).toEqual(Option.none())
  })

  it.live("makeEffect fails on an unknown key and names it", () =>
    Effect.gen(function* () {
      const old = { name: AgentName.make("painter"), allowedTools: ["read"] }
      const built = yield* Effect.result(AgentDefinition.makeEffect(old))
      expect(Result.isFailure(built)).toBe(true)
      if (Result.isFailure(built)) {
        expect(SchemaIssue.makeFormatterDefault()(built.failure)).toContain(
          'AgentDefinition "painter" has keys the schema does not name: allowedTools',
        )
      }
    }),
  )

  it.live("makeEffect and makeOption still build an agent with known keys", () =>
    Effect.gen(function* () {
      const reader = { name: AgentName.make("reader"), tools: ["read"] }
      const built = yield* AgentDefinition.makeEffect(reader)
      expect(built.admitsTool("bash")).toBe(false)
      expect(Option.map(AgentDefinition.makeOption(reader), (agent) => agent.tools)).toEqual(
        Option.some(["read"]),
      )
    }),
  )
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
