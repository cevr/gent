/**
 * Scope precedence regression locks.
 *
 * Locks the rule that builtin < user < project across:
 *  - keyed contributions (tools, agents, prompt sections) — later scope wins
 *  - explicit prompt slots (later scope applies after earlier scope)
 *  - alphabetical tie-break on extension id within the same scope
 *
 * Providers and turn executors share the keyed-contribution code path
 * (`compileContributions` in registry.ts) — the tools test exercises that path.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionContributions, LoadedExtension } from "../../src/domain/extension.js"
import { BranchId, ExtensionId, SessionId } from "@gent/core/domain/ids"

const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { PermissionRule } from "@gent/core/domain/permission"
import { tool } from "@gent/core/extensions/api"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import type { AgentDefinition } from "@gent/core/domain/agent"
import { AgentName } from "@gent/core/domain/agent"

const stubCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: Agents["cowork"]!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

const toolReturning = (name: string, label: string) =>
  tool({
    id: name,
    description: label,
    params: Schema.Struct({}),
    execute: () => Effect.succeed(label),
  })

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

describe("scope precedence", () => {
  describe("keyed contributions — later scope wins", () => {
    it.live("tool with same name: project shadows user shadows builtin", () => {
      const builtinTool = toolReturning("greet", "from-builtin")
      const userTool = toolReturning("greet", "from-user")
      const projectTool = toolReturning("greet", "from-project")

      const resolved = resolveExtensions([
        ext("a", "builtin", { tools: [builtinTool] }),
        ext("b", "user", { tools: [userTool] }),
        ext("c", "project", { tools: [projectTool] }),
      ])

      const resolvedTool = resolved.modelCapabilities.get("greet")!
      return narrowR(
        resolvedTool
          .effect({}, {} as never)
          .pipe(Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-project")))),
      )
    })

    it.live("agent with same name: project shadows builtin", () => {
      const builtinAgent = Agents["cowork"]!
      const projectAgent = { ...Agents["cowork"]!, description: "shadowed" } as AgentDefinition

      const resolved = resolveExtensions([
        ext("a", "builtin", { agents: [builtinAgent] }),
        ext("b", "project", { agents: [projectAgent] }),
      ])
      return Effect.sync(() => expect(resolved.agents.get("cowork")?.description).toBe("shadowed"))
    })

    it.live("prompt section by id: project tool prompt shadows builtin", () => {
      const builtinTool = tool({
        id: "carrier-builtin",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "rules", content: "builtin rules", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = tool({
        id: "carrier-project",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "rules", content: "project rules", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { tools: [builtinTool] }),
        ext("b", "project", { tools: [projectTool] }),
      ])
      return Effect.sync(() =>
        expect(resolved.promptSections.get("rules")).toMatchObject({ content: "project rules" }),
      )
    })

    it.live("tool prompt: shadowed lower-scope prompt does NOT survive", () => {
      // C7 codex BLOCKER: previously, prompts/rules were collected from raw
      // extracted leaves, not winners. A higher-scope tool shadowing a
      // lower-scope tool would leak the loser's prompt.
      const builtinTool = tool({
        id: "shadow-me",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "shadow-prompt", content: "BUILTIN PROMPT", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = tool({
        id: "shadow-me",
        description: "carrier",
        params: Schema.Struct({}),
        // NO prompt — should remove the section
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { tools: [builtinTool] }),
        ext("b", "project", { tools: [projectTool] }),
      ])
      return Effect.sync(() => expect(resolved.promptSections.has("shadow-prompt")).toBe(false))
    })

    it.live("tool permissionRules: shadowed lower-scope rules do NOT survive", () => {
      // C7 codex BLOCKER companion: a project-scope tool shadowing the
      // builtin `bash` without `permissionRules` must NOT inherit the
      // builtin's deny rules.
      const builtinTool = tool({
        id: "shadow-rules",
        description: "carrier",
        params: Schema.Struct({}),
        permissionRules: [new PermissionRule({ tool: "shadow-rules", action: "deny" })],
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = tool({
        id: "shadow-rules",
        description: "carrier",
        params: Schema.Struct({}),
        // NO permissionRules — should remove the rule
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { tools: [builtinTool] }),
        ext("b", "project", { tools: [projectTool] }),
      ])
      // The deny rule must be gone — project shadowed the builtin entirely.
      return Effect.sync(() => expect(resolved.permissionRules).toEqual([]))
    })

    it.live("same scope ties broken by extension id alphabetically", () => {
      const toolFromZ = toolReturning("greet", "from-z")
      const toolFromA = toolReturning("greet", "from-a")

      // Pass in reverse order to prove the registry sorts, not just respects insertion
      const resolved = resolveExtensions([
        ext("z-ext", "builtin", { tools: [toolFromZ] }),
        ext("a-ext", "builtin", { tools: [toolFromA] }),
      ])

      // Sorted [a-ext, z-ext] — z-ext registered last, so wins
      const resolvedTool = resolved.modelCapabilities.get("greet")!
      return narrowR(
        resolvedTool
          .effect({}, {} as never)
          .pipe(Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-z")))),
      )
    })
  })

  describe("explicit prompt slots — project applies after user after builtin", () => {
    it.live("systemPrompt rewrite order follows scope precedence", () => {
      const make = (id: string, scope: "builtin" | "user" | "project") =>
        ext(id, scope, {
          reactions: {
            systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[${scope}]`),
          },
        })

      // Pass out of order to prove sorting, not insertion
      const compiled = compileExtensionReactions([
        make("p", "project"),
        make("a", "builtin"),
        make("u", "user"),
      ])

      return compiled
        .resolveSystemPrompt(
          { basePrompt: "x", agent: Agents["cowork"]! },
          { projection: stubProjectionCtx, host: stubCtx },
        )
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => expect(result).toBe("x[builtin][user][project]")),
          ),
        )
    })
  })
})
