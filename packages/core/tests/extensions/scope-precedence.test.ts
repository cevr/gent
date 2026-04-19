/**
 * Scope precedence regression locks.
 *
 * Locks the rule that builtin < user < project across:
 *  - keyed contributions (tools, agents, prompt sections) — later scope wins
 *  - pipeline chain (later scope wraps earlier — outermost runs first)
 *  - alphabetical tie-break on extension id within the same scope
 *
 * Providers and turn executors share the keyed-contribution code path
 * (`compileContributions` in registry.ts) — the tools test exercises that path.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionContributions, LoadedExtension } from "@gent/core/domain/extension"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { definePipeline } from "@gent/core/domain/pipeline"
import { compilePipelines } from "@gent/core/runtime/extensions/pipeline-host"
import { defineTool } from "@gent/core/domain/tool"
import { PermissionRule } from "@gent/core/domain/permission"
import { pipeline, tool } from "@gent/core/domain/contribution"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const toolReturning = (name: string, label: string) =>
  defineTool({
    name,
    description: label,
    params: Schema.Struct({}),
    execute: () => Effect.succeed(label),
  })

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({ manifest: { id }, kind, sourcePath: `/test/${id}`, contributions })

describe("scope precedence", () => {
  describe("keyed contributions — later scope wins", () => {
    it.live("tool with same name: project shadows user shadows builtin", () => {
      const builtinTool = toolReturning("greet", "from-builtin")
      const userTool = toolReturning("greet", "from-user")
      const projectTool = toolReturning("greet", "from-project")

      const resolved = resolveExtensions([
        ext("a", "builtin", { capabilities: [tool(builtinTool)] }),
        ext("b", "user", { capabilities: [tool(userTool)] }),
        ext("c", "project", { capabilities: [tool(projectTool)] }),
      ])

      const resolvedTool = resolved.tools.get("greet")!
      return resolvedTool
        .execute({}, {} as never)
        .pipe(Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-project"))))
    })

    it.live("agent with same name: project shadows builtin", () => {
      const builtinAgent = Agents.cowork
      const projectAgent = { ...Agents.cowork, description: "shadowed" }

      const resolved = resolveExtensions([
        ext("a", "builtin", { agents: [builtinAgent] }),
        ext("b", "project", { agents: [projectAgent] }),
      ])
      return Effect.sync(() => expect(resolved.agents.get("cowork")?.description).toBe("shadowed"))
    })

    it.live("prompt section by id (Capability.prompt): project shadows builtin", () => {
      const builtinTool = defineTool({
        name: "carrier-builtin",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "rules", content: "builtin rules", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = defineTool({
        name: "carrier-project",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "rules", content: "project rules", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { capabilities: [tool(builtinTool)] }),
        ext("b", "project", { capabilities: [tool(projectTool)] }),
      ])
      return Effect.sync(() =>
        expect(resolved.promptSections.get("rules")).toMatchObject({ content: "project rules" }),
      )
    })

    it.live("Capability.prompt: shadowed capability's prompt does NOT survive", () => {
      // C7 codex BLOCKER: previously, prompts/rules were collected from raw
      // extracted capabilities, not winners. A higher-scope capability
      // shadowing a lower-scope tool would leak the loser's prompt.
      const builtinTool = defineTool({
        name: "shadow-me",
        description: "carrier",
        params: Schema.Struct({}),
        prompt: { id: "shadow-prompt", content: "BUILTIN PROMPT", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = defineTool({
        name: "shadow-me",
        description: "carrier",
        params: Schema.Struct({}),
        // NO prompt — should remove the section
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { capabilities: [tool(builtinTool)] }),
        ext("b", "project", { capabilities: [tool(projectTool)] }),
      ])
      return Effect.sync(() => expect(resolved.promptSections.has("shadow-prompt")).toBe(false))
    })

    it.live("Capability.permissionRules: shadowed capability's rules do NOT survive", () => {
      // C7 codex BLOCKER companion: a project-scope tool shadowing the
      // builtin `bash` without `permissionRules` must NOT inherit the
      // builtin's deny rules.
      const builtinTool = defineTool({
        name: "shadow-rules",
        description: "carrier",
        params: Schema.Struct({}),
        permissionRules: [new PermissionRule({ tool: "shadow-rules", action: "deny" })],
        execute: () => Effect.succeed("ok"),
      })
      const projectTool = defineTool({
        name: "shadow-rules",
        description: "carrier",
        params: Schema.Struct({}),
        // NO permissionRules — should remove the rule
        execute: () => Effect.succeed("ok"),
      })

      const resolved = resolveExtensions([
        ext("a", "builtin", { capabilities: [tool(builtinTool)] }),
        ext("b", "project", { capabilities: [tool(projectTool)] }),
      ])
      // The deny rule must be gone — project shadowed the builtin entirely.
      return Effect.sync(() => expect(resolved.permissionRules).toEqual([]))
    })

    it.live("same scope ties broken by extension id alphabetically", () => {
      const toolFromZ = toolReturning("greet", "from-z")
      const toolFromA = toolReturning("greet", "from-a")

      // Pass in reverse order to prove the registry sorts, not just respects insertion
      const resolved = resolveExtensions([
        ext("z-ext", "builtin", { capabilities: [tool(toolFromZ)] }),
        ext("a-ext", "builtin", { capabilities: [tool(toolFromA)] }),
      ])

      // Sorted [a-ext, z-ext] — z-ext registered last, so wins
      const resolvedTool = resolved.tools.get("greet")!
      return resolvedTool
        .execute({}, {} as never)
        .pipe(Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-z"))))
    })
  })

  describe("pipeline chain — project wraps user wraps builtin", () => {
    it.live("execution order proves project is outermost", () => {
      const log: string[] = []
      const make = (id: string, kind: "builtin" | "user" | "project") =>
        ext(id, kind, {
          pipelines: [
            pipeline(
              definePipeline("prompt.system", (input, next) => {
                log.push(`${kind}-before`)
                return next(input).pipe(
                  Effect.map((r) => {
                    log.push(`${kind}-after`)
                    return r
                  }),
                )
              }),
            ),
          ],
        })

      // Pass out of order to prove sorting, not insertion
      const compiled = compilePipelines([
        make("p", "project"),
        make("a", "builtin"),
        make("u", "user"),
      ])

      return compiled
        .runPipeline(
          "prompt.system",
          { basePrompt: "x", agent: Agents.cowork },
          () => Effect.succeed("base"),
          stubCtx,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              expect(log).toEqual([
                "project-before",
                "user-before",
                "builtin-before",
                "builtin-after",
                "user-after",
                "project-after",
              ]),
            ),
          ),
        )
    })
  })
})
