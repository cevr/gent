import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { BuiltinExtensions } from "@gent/core/extensions"
import type { ExtensionSetup } from "@gent/core/domain/extension"

const loadAll = (): Promise<{ id: string; setup: ExtensionSetup }[]> =>
  Promise.all(
    BuiltinExtensions.map((ext) =>
      Effect.runPromise(
        ext.setup({ cwd: "/tmp", config: undefined as never, source: "test" }),
      ).then((setup) => ({ id: ext.manifest.id, setup })),
    ),
  )

describe("BuiltinExtensions", () => {
  test("all extensions load without error", async () => {
    const results = await loadAll()
    expect(results.length).toBe(BuiltinExtensions.length)
    for (const r of results) {
      expect(r.setup).toBeDefined()
    }
  })

  test("no duplicate extension ids", () => {
    const ids = BuiltinExtensions.map((ext) => ext.manifest.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  test("no duplicate tool names across extensions", async () => {
    const results = await loadAll()
    const allToolNames = results.flatMap((r) => (r.setup.tools ?? []).map((t) => t.name))
    const unique = new Set(allToolNames)
    expect(unique.size).toBe(allToolNames.length)
  })

  test("no duplicate agent names across extensions", async () => {
    const results = await loadAll()
    const allAgentNames = results.flatMap((r) => (r.setup.agents ?? []).map((a) => a.name))
    const unique = new Set(allAgentNames)
    expect(unique.size).toBe(allAgentNames.length)
  })

  test("all expected tools are present", async () => {
    const results = await loadAll()
    const allToolNames = new Set(results.flatMap((r) => (r.setup.tools ?? []).map((t) => t.name)))

    // Core tools
    for (const name of ["read", "write", "edit", "bash", "glob", "grep"]) {
      expect(allToolNames.has(name)).toBe(true)
    }
    // Subagent tools
    for (const name of ["delegate", "handoff", "search_skills"]) {
      expect(allToolNames.has(name)).toBe(true)
    }
    // Delegate tools
    for (const name of ["plan", "audit", "loop"]) {
      expect(allToolNames.has(name)).toBe(true)
    }
  })

  test("all expected agents are present", async () => {
    const results = await loadAll()
    const allAgentNames = new Set<string>(
      results.flatMap((r) => (r.setup.agents ?? []).map((a) => a.name)),
    )

    for (const name of [
      "cowork",
      "deepwork",
      "explore",
      "architect",
      "librarian",
      "summarizer",
      "title",
      "finder",
      "reviewer",
      "auditor",
    ]) {
      expect(allAgentNames.has(name)).toBe(true)
    }
  })

  test("agents have model set", async () => {
    const results = await loadAll()
    const agents = results.flatMap((r) => r.setup.agents ?? [])
    for (const agent of agents) {
      expect(agent.model).toBeDefined()
    }
  })

  test("loop_evaluation injected via tagInjections", async () => {
    const results = await loadAll()
    const allToolNames = new Set(results.flatMap((r) => (r.setup.tools ?? []).map((t) => t.name)))
    // loop_evaluation should NOT be in the base tool set — it's tag-injected
    expect(allToolNames.has("loop_evaluation")).toBe(false)
    // But the tag injection should exist
    const tagInjections = results.flatMap((r) => r.setup.tagInjections ?? [])
    const loopTag = tagInjections.find((t) => t.tag === "loop-evaluation")
    expect(loopTag).toBeDefined()
    expect(loopTag?.tools.map((t) => t.name)).toContain("loop_evaluation")
  })
})
