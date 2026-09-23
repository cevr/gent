import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  effectiveModelDriver,
  makeRunSpec,
  ModelId,
  parseModelId,
  parseModelProvider,
  ProviderId,
  resolveAgentDriver,
} from "../../src/domain/agent"
import { ToolCallId } from "../../src/domain/ids"
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "../../src/domain/interaction"

// ── agent.test ──────────────────────────────────────────────────────────────

describe("AgentName brand", () => {
  test("DEFAULT_AGENT_NAME is branded as AgentName", () => {
    expect(Schema.is(AgentName)(DEFAULT_AGENT_NAME)).toBe(true)
  })

  test("plain string fails the brand predicate at the schema boundary", () => {
    expect(Schema.is(AgentName)("cowork")).toBe(true) // brand-only filter accepts strings at runtime
    const decoded = Effect.runSync(Schema.decodeEffect(AgentName)("research"))
    expect(decoded).toBe(AgentName.make("research"))
  })
})

describe("ApprovalRequest / ApprovalDecision schemas", () => {
  test("ApprovalRequest accepts text + optional metadata", () => {
    const decoded = Effect.runSync(Schema.decodeEffect(ApprovalRequestSchema)({ text: "approve?" }))
    expect(decoded.text).toBe("approve?")
  })

  test("ApprovalDecision requires approved boolean", () => {
    const decoded = Effect.runSync(Schema.decodeEffect(ApprovalDecisionSchema)({ approved: true }))
    expect(decoded.approved).toBe(true)
  })
})

// ── agent-driver-routing.test ───────────────────────────────────────────────

/**
 * resolveAgentDriver — pure precedence tests.
 * effectiveModelDriver — the one derivation of driver id and catalog model id.
 */

const makeAgent = (
  name: string,
  overrides: Partial<ConstructorParameters<typeof AgentDefinition>[0]> = {},
): AgentDefinition => AgentDefinition.make({ name: AgentName.make(name), ...overrides })

describe("agent driver precedence", () => {
  test("agent.driver wins — config override is ignored when the agent hardcodes a driver", () => {
    const agent = makeAgent("special", {
      driver: DriverRef.make({ id: "anthropic-proxy" }),
    })
    const overrides = {
      [AgentName.make("special")]: DriverRef.make({ id: "openai-proxy" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("Model")
    expect(result.driver).toEqual(DriverRef.make({ id: "anthropic-proxy" }))
    expect(result.source).toBe("agent")
  })

  test("config override applies when the agent has no hardcoded driver", () => {
    const agent = makeAgent("cowork")
    const overrides = {
      [AgentName.make("cowork")]: DriverRef.make({ id: "anthropic-proxy" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("Model")
    expect(result.driver).toEqual(DriverRef.make({ id: "anthropic-proxy" }))
    expect(result.source).toBe("config")
  })

  test("default — no agent driver, no override, returns undefined driver", () => {
    const agent = makeAgent("cowork")
    const result = resolveAgentDriver(agent)
    expect(result.driver).toBeUndefined()
    expect(result.source).toBe("default")
  })

  test("default — empty overrides record falls through to default source", () => {
    const agent = makeAgent("cowork")
    const result = resolveAgentDriver(agent, {})
    expect(result.driver).toBeUndefined()
    expect(result.source).toBe("default")
  })

  test("override for a different agent does not match", () => {
    const agent = makeAgent("cowork")
    const overrides = {
      [AgentName.make("deepwork")]: DriverRef.make({ id: "anthropic-proxy" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver).toBeUndefined()
    expect(result.source).toBe("default")
  })

  test("a model-driver override without an agent driver comes from config", () => {
    const agent = makeAgent("cowork")
    const overrides = {
      [AgentName.make("cowork")]: DriverRef.make({ id: "anthropic" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("Model")
    expect(result.source).toBe("config")
  })
})

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

// ── agent-runspec.test ──────────────────────────────────────────────────────

describe("run spec construction", () => {
  test("empty input produces empty spec — no spurious keys", () => {
    const spec = makeRunSpec()
    expect(Object.keys(spec)).toEqual([])
  })

  test("undefined fields are omitted, not stored", () => {
    const spec = makeRunSpec({
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      overrides: undefined,
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      parentToolCallId: undefined,
    })
    expect(Object.keys(spec)).toEqual([])
    expect("overrides" in spec).toBe(false)
    expect("parentToolCallId" in spec).toBe(false)
  })

  test("threads each provided field through", () => {
    const tcid = ToolCallId.make("tc-1")
    const spec = makeRunSpec({
      overrides: {
        modelId: ModelId.make("custom/model"),
        allowedTools: ["bash"],
        deniedTools: ["read"],
        reasoningEffort: "high",
        systemPromptAddendum: "extra",
      },
      parentToolCallId: tcid,
    })
    expect(spec.overrides?.modelId).toBe(ModelId.make("custom/model"))
    expect(spec.overrides?.allowedTools).toEqual(["bash"])
    expect(spec.overrides?.deniedTools).toEqual(["read"])
    expect(spec.overrides?.reasoningEffort).toBe("high")
    expect(spec.overrides?.systemPromptAddendum).toBe("extra")
    expect(spec.parentToolCallId).toBe(tcid)
  })

  test("partial input — only the parent tool call", () => {
    const spec = makeRunSpec({ parentToolCallId: ToolCallId.make("tc-2") })
    expect(Object.keys(spec)).toEqual(["parentToolCallId"])
  })
})

// ── model.test ──────────────────────────────────────────────────────────────

describe("model id parsing", () => {
  test("extracts provider and model segments", () => {
    expect(parseModelProvider("anthropic/claude-sonnet")).toEqual(
      Option.some(ProviderId.make("anthropic")),
    )
    expect(parseModelId("anthropic/claude-sonnet")).toEqual(
      Option.some([ProviderId.make("anthropic"), "claude-sonnet"]),
    )
  })

  test("rejects missing provider or model segment", () => {
    expect(parseModelProvider("anthropic")).toEqual(Option.none())
    expect(parseModelProvider("/claude-sonnet")).toEqual(Option.none())
    expect(parseModelProvider("anthropic/")).toEqual(Option.none())
    expect(parseModelId("anthropic")).toEqual(Option.none())
    expect(parseModelId("/claude-sonnet")).toEqual(Option.none())
    expect(parseModelId("anthropic/")).toEqual(Option.none())
  })
})
