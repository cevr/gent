/**
 * resolveAgentDriver — pure precedence tests.
 * effectiveModelDriver — the one derivation of driver id and catalog model id.
 */
import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import {
  AgentDefinition,
  AgentName,
  type DriverRef,
  effectiveModelDriver,
  ExternalDriverRef,
  ModelDriverRef,
  ModelId,
  resolveAgentDriver,
} from "../../src/domain/agent"

const makeAgent = (
  name: string,
  overrides: Partial<ConstructorParameters<typeof AgentDefinition>[0]> = {},
): AgentDefinition => AgentDefinition.make({ name: AgentName.make(name), ...overrides })

describe("agent driver precedence", () => {
  test("agent.driver wins — config override is ignored when the agent hardcodes a driver", () => {
    const agent = makeAgent("special", {
      driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
    })
    const overrides = {
      [AgentName.make("special")]: ExternalDriverRef.make({ id: "acp-opencode" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("External")
    expect(result.driver).toEqual(ExternalDriverRef.make({ id: "acp-claude-code" }))
    expect(result.source).toBe("agent")
  })

  test("config override applies when the agent has no hardcoded driver", () => {
    const agent = makeAgent("cowork")
    const overrides = {
      [AgentName.make("cowork")]: ExternalDriverRef.make({ id: "acp-claude-code" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("External")
    expect(result.driver).toEqual(ExternalDriverRef.make({ id: "acp-claude-code" }))
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
      [AgentName.make("deepwork")]: ExternalDriverRef.make({ id: "acp-claude-code" }),
    } satisfies Record<string, DriverRef>
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver).toBeUndefined()
    expect(result.source).toBe("default")
  })

  test("model-driver override is honoured the same way as external", () => {
    const agent = makeAgent("cowork")
    const overrides = {
      [AgentName.make("cowork")]: ModelDriverRef.make({ id: "anthropic" }),
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
      Option.some(ModelDriverRef.make({ id: "anthropic-proxy" })),
      modelId,
    )
    expect(result.driverId).toEqual(Option.some("anthropic-proxy"))
    expect(result.contextModelId).toBe(ModelId.make("anthropic-proxy/claude-sonnet-5"))
  })

  test("a model driver without an id falls back to the provider segment", () => {
    const result = effectiveModelDriver(Option.some(ModelDriverRef.make({})), modelId)
    expect(result.driverId).toEqual(Option.some("anthropic"))
    expect(result.contextModelId).toBe(modelId)
  })

  test("an external driver leaves the model path on the provider segment", () => {
    const result = effectiveModelDriver(
      Option.some(ExternalDriverRef.make({ id: "acp-claude-code" })),
      modelId,
    )
    expect(result.driverId).toEqual(Option.some("anthropic"))
    expect(result.contextModelId).toBe(modelId)
  })

  test("an unparseable model id yields no driver and an unchanged context model id", () => {
    const bare = ModelId.make("claude-sonnet-5")
    const result = effectiveModelDriver(
      Option.some(ModelDriverRef.make({ id: "anthropic-proxy" })),
      bare,
    )
    expect(result.driverId).toEqual(Option.some("anthropic-proxy"))
    expect(result.contextModelId).toBe(bare)
    expect(effectiveModelDriver(absentDriver, bare).driverId).toEqual(Option.none())
  })
})
