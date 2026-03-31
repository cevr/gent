import { describe, test, expect } from "bun:test"
import { Agents, resolveAgentModel } from "@gent/core/domain/agent"

describe("Built-in Agent Definitions", () => {
  test("auditor agent exists and is a subagent", () => {
    expect(Agents.auditor).toBeDefined()
    expect(Agents.auditor.kind).toBe("subagent")
    expect(Agents.auditor.name).toBe("auditor")
  })

  test("cowork can delegate to auditor", () => {
    expect(Agents.cowork.canDelegateToAgents).toContain("auditor")
  })

  test("deepwork is hidden primary (reviewer only)", () => {
    expect(Agents.deepwork.kind).toBe("primary")
    expect(Agents.deepwork.hidden).toBe(true)
  })

  test("auditor has read + bash tools", () => {
    expect(Agents.auditor.allowedActions).toEqual(["read"])
    expect(Agents.auditor.allowedTools).toEqual(["bash"])
  })

  test("auditor agent has model set", () => {
    expect(Agents.auditor.model).toBeDefined()
    expect(resolveAgentModel(Agents.auditor)).toBeDefined()
  })
})
