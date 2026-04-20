/**
 * resolveAgentDriver — pure precedence tests.
 */
import { describe, test, expect } from "bun:test"
import {
  AgentDefinition,
  ExternalDriverRef,
  ModelDriverRef,
  resolveAgentDriver,
  type DriverRef,
} from "@gent/core/domain/agent"

const makeAgent = (
  name: string,
  overrides: Partial<ConstructorParameters<typeof AgentDefinition>[0]> = {},
): AgentDefinition =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  new AgentDefinition({ name: name as never, ...overrides })

describe("resolveAgentDriver", () => {
  test("agent.driver wins — config override is ignored when the agent hardcodes a driver", () => {
    const agent = makeAgent("special", {
      driver: new ExternalDriverRef({ id: "acp-claude-code" }),
    })
    const overrides: Record<string, DriverRef> = {
      special: new ExternalDriverRef({ id: "acp-opencode" }),
    }
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("external")
    expect(result.driver?._tag === "external" ? result.driver.id : undefined).toBe(
      "acp-claude-code",
    )
    expect(result.source).toBe("agent")
  })

  test("config override applies when the agent has no hardcoded driver", () => {
    const agent = makeAgent("cowork")
    const overrides: Record<string, DriverRef> = {
      cowork: new ExternalDriverRef({ id: "acp-claude-code" }),
    }
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("external")
    expect(result.driver?._tag === "external" ? result.driver.id : undefined).toBe(
      "acp-claude-code",
    )
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
    const overrides: Record<string, DriverRef> = {
      deepwork: new ExternalDriverRef({ id: "acp-claude-code" }),
    }
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver).toBeUndefined()
    expect(result.source).toBe("default")
  })

  test("model-driver override is honoured the same way as external", () => {
    const agent = makeAgent("cowork")
    const overrides: Record<string, DriverRef> = {
      cowork: new ModelDriverRef({ id: "anthropic" }),
    }
    const result = resolveAgentDriver(agent, overrides)
    expect(result.driver?._tag).toBe("model")
    expect(result.source).toBe("config")
  })
})
