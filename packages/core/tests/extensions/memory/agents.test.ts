import { describe, test, expect } from "bun:test"
import { MemoryReflectAgent, MemoryMeditateAgent } from "@gent/core/extensions/memory/agents"

describe("memory agents", () => {
  test("reflect agent has correct properties", () => {
    expect(MemoryReflectAgent.name).toBe("memory:reflect")
    expect(MemoryReflectAgent.model).toBeDefined()
    expect(MemoryReflectAgent.systemPromptAddendum).toBeDefined()
    expect(MemoryReflectAgent.systemPromptAddendum!.length).toBeGreaterThan(100)
  })

  test("reflect agent has restricted tool set", () => {
    const tools = MemoryReflectAgent.allowedTools ?? []
    expect(tools).toContain("memory_remember")
    expect(tools).toContain("memory_recall")
    expect(tools).toContain("memory_forget")
    expect(tools).toContain("search_sessions")
    // Should NOT have tools that spawn subagents
    expect(tools).not.toContain("delegate")
    expect(tools).not.toContain("handoff")
  })

  test("meditate agent has correct properties", () => {
    expect(MemoryMeditateAgent.name).toBe("memory:meditate")
    expect(MemoryMeditateAgent.model).toBeDefined()
    expect(MemoryMeditateAgent.systemPromptAddendum).toBeDefined()
  })

  test("meditate agent has memory-only tools", () => {
    const tools = MemoryMeditateAgent.allowedTools ?? []
    expect(tools).toContain("memory_remember")
    expect(tools).toContain("memory_recall")
    expect(tools).toContain("memory_forget")
    // Meditate doesn't need session search
    expect(tools).not.toContain("search_sessions")
  })

  test("both agents have different names", () => {
    expect(MemoryReflectAgent.name).not.toBe(MemoryMeditateAgent.name)
  })
})
