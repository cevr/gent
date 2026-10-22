import { describe, expect, test } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, Option, Result, Schema, SchemaIssue } from "effect"
import {
  AgentDefinition,
  AgentName,
  bindSessionAgent,
  cacheWriteRate,
  calculateCost,
  DriverRef,
  effectiveModelDriver,
  ModelId,
  noRunBound,
  parseModelId,
  ProviderId,
  resolveSessionAgent,
  RunSpecSchema,
  scopeReaches,
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

// ── the previous gent ───────────────────────────────────────────────────────

/**
 * An agent as a client of the previous gent reads it (the base of the
 * `tools` change): a test fixture, so a reply written now is read here the
 * way an older client reads it.
 */
const PreviousAgentDefinition = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
})

const readRunSpec = Schema.decodeSync(Schema.fromJsonString(RunSpecSchema))

describe("an agent the previous gent's client reads", () => {
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

// ── run tools ──────────────────────────────────────────────────────────

/** The agent `name` runs as, in cwd `/w` with no parent, under the run overrides a stored row holds. */
const runAs = (agent: AgentDefinition, row: string) => {
  const overrides = Option.fromUndefinedOr(readRunSpec(row).overrides)
  const definition = resolveSessionAgent({
    agents: [agent],
    configAgents: Option.none(),
    name: agent.name,
    overrides,
  }).pipe(Option.getOrThrow)
  return bindSessionAgent(definition, { overrides, cwd: "/w", parent: noRunBound })
}

describe("run tools", () => {
  const reader = AgentDefinition.make({
    name: AgentName.make("reader"),
    tools: ["read", "grep", "!bash"],
  })
  const held = (agent: AgentDefinition) =>
    ["read", "grep", "write", "bash"].filter((id) => agent.admitsTool(id))

  test("new tool patterns narrow the agent's tools", () => {
    expect(held(runAs(reader, '{"overrides":{"tools":["*","!read"]}}'))).toEqual(["grep"])
  })

  test("a run's tools [*] holds what the agent holds and no more", () => {
    expect(held(runAs(reader, '{"overrides":{"tools":["*"]}}'))).toEqual(["read", "grep"])
  })
})

// ── run narrowing ───────────────────────────────────────────────────────────

describe("run narrowing", () => {
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`)

  test("a scope reaches an entry inside one of its entries with at least its access", () => {
    const scope = [
      { path: "/w/a", access: "write" as const },
      { path: "/w/docs", access: "read" as const },
    ]
    expect(scopeReaches(scope, { path: "/w/a/b", access: "write" }, within)).toBe(true)
    expect(scopeReaches(scope, { path: "/w/a", access: "read" }, within)).toBe(true)
    expect(scopeReaches(scope, { path: "/w/docs/x", access: "read" }, within)).toBe(true)
    // A write entry under a read entry asks for more access.
    expect(scopeReaches(scope, { path: "/w/docs/x", access: "write" }, within)).toBe(false)
    // An entry outside every entry, or one that holds an entry, is not reached.
    expect(scopeReaches(scope, { path: "/w/b", access: "read" }, within)).toBe(false)
    expect(scopeReaches(scope, { path: "/w", access: "read" }, within)).toBe(false)
  })

  test("a run's paths add a scope after the agent's own", () => {
    const painter = AgentDefinition.make({
      name: AgentName.make("painter"),
      paths: [{ path: "a", access: "write" }],
    })
    const run = runAs(painter, '{"overrides":{"paths":[{"path":"a/b","access":"read"}]}}')
    expect(run.pathScopes()).toEqual([
      { cwd: "/w", entries: [{ path: "a", access: "write" }] },
      { cwd: "/w", entries: [{ path: "a/b", access: "read" }] },
    ])
  })

  test("an agent takes no narrowing as authoring input", () => {
    const authored = {
      name: AgentName.make("painter"),
      narrowings: [{ tools: ["read"] }],
    }
    expect(() => AgentDefinition.make(authored)).toThrow("has keys the schema does not name")
  })

  // driver.list sends roster definitions; a client decodes them.
  test("a definition through the wire admits the tools and paths it admits in process", () => {
    const painter = AgentDefinition.make({
      name: AgentName.make("painter"),
      tools: ["read", "write", "!bash"],
      paths: [
        { path: "a", access: "write" },
        { path: "docs", access: "read" },
      ],
    })
    const wire = Schema.encodeSync(Schema.fromJsonString(StoredAgentDefinition))(painter)
    const decoded = Schema.decodeSync(Schema.fromJsonString(StoredAgentDefinition))(wire)
    for (const id of ["read", "write", "bash", "grep"]) {
      expect(decoded.admitsTool(id)).toBe(painter.admitsTool(id))
    }
    expect(decoded.paths).toEqual(painter.paths)
  })

  test("a session's run agent does not go out as a definition", () => {
    const run = runAs(
      AgentDefinition.make({ name: AgentName.make("painter"), tools: ["read", "write"] }),
      '{"overrides":{"tools":["read"]}}',
    )
    expect(() => Schema.encodeSync(StoredAgentDefinition)(run)).toThrow("run agent")
  })

  test("a run's other overrides still reshape the agent", () => {
    const painter = AgentDefinition.make({ name: AgentName.make("painter"), maxSteps: 10 })
    const run = runAs(painter, '{"overrides":{"maxSteps":3,"tools":["read"]}}')
    expect(run.maxSteps).toBe(3)
    expect(run.tools).toBeUndefined()
    expect(run.admitsTool("read")).toBe(true)
    expect(run.admitsTool("write")).toBe(false)
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
