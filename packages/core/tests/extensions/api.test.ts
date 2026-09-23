import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Predicate, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  type ExtensionHostService,
  type GentExtension,
  getToolId,
  request,
  tool,
} from "@gent/core/extensions/api"
import { ExtensionId } from "../../src/domain/ids"
import { GentToolMetadataTag, getToolMetadata } from "../../src/domain/capability"
import {
  ExtensionLoadError,
  type LoadedExtension,
  validateExtensionPackage,
} from "../../src/domain/extension"
import {
  buildResourceLayer,
  compileExtensionHooks,
  CurrentExtensionHostContext,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import { collectTestContributions, testExtensionHostContext } from "../../src/test-utils/harness"
import * as AiTool from "effect/unstable/ai/Tool"
import { testAgent } from "../helpers/test-preset"
import { DEFAULT_AGENT_NAME } from "../../src/domain/agent"

// ── define-extension.test ───────────────────────────────────────────────────

/**
 * defineExtension regression locks.
 *
 * Locks the contract that `defineExtension({ id, setup })` registers through
 * `ExtensionHost` and seals into the `ExtensionContributions` record the
 * runtime registry consumes. Each domain round-trips, lifecycle effects
 * compose in registration order, and the result wires into `ExtensionRegistry`.
 */

const stubHostCtx = testExtensionHostContext()

const setupOf = <R>(ext: GentExtension<R>) => collectTestContributions(ext.setup)

describe("defineExtension", () => {
  const test = it.live.layer(BunServices.layer)

  test("empty setup produces an empty contributions record", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "empty", setup: Effect.void })
      const contributions = yield* setupOf(ext)
      expect(contributions).toEqual({})
    }))

  test("seal drops domains with no registrations", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "zero-values",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool")
          yield* host.register("agent")
          yield* host.register("resource")
          yield* host.register("request")
        }),
      })
      const contributions = yield* setupOf(ext)
      expect(contributions.tools).toBeUndefined()
      expect(contributions.agents).toBeUndefined()
      expect(contributions.resources).toBeUndefined()
      expect(contributions.requests).toBeUndefined()
      expect(contributions.hooks).toBeUndefined()
    }))

  test("each kind round-trips into its corresponding bucket", () =>
    Effect.gen(function* () {
      const myTool = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
      const myLayer = Layer.empty
      const ext = defineExtension({
        id: "all-kinds",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", myTool)
          yield* host.register("agent", testAgent)
          yield* host.on("systemPrompt", (input) => Effect.succeed(`${input.basePrompt} [suffix]`))
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The registration intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/define-extension/all-kinds/resource",
              scope: "process",
              layer: myLayer,
            }) as never,
          )
        }),
      })
      const contributions = yield* setupOf(ext)
      const modelCaps = contributions.tools ?? []
      const firstModelCap = modelCaps[0]
      expect(firstModelCap).toBeDefined()
      if (Predicate.isUndefined(firstModelCap)) return
      expect(String(getToolId(firstModelCap))).toBe("echo")
      expect((contributions.agents ?? [])[0]?.name).toBe(DEFAULT_AGENT_NAME)
      expect(contributions.hooks?.[0]?.kind).toBe("systemPrompt")
      const resources = contributions.resources ?? []
      expect(resources).toHaveLength(1)
    }))

  test("resource layers acquire at scope build and release at teardown in declaration / reverse order", () =>
    Effect.gen(function* () {
      const log: string[] = []
      const append = (s: string) => Effect.sync(() => log.push(s))
      const lifecycle = (n: number) =>
        Layer.effectDiscard(
          Effect.acquireRelease(append(`startup-${n}`), () => append(`shutdown-${n}`)),
        )
      const ext = defineExtension({
        id: "lifecycle",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The registration intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/define-extension/lifecycle/resource-1",
              scope: "process",
              layer: lifecycle(1),
            }) as never,
          )
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The registration intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/define-extension/lifecycle/resource-2",
              scope: "process",
              layer: lifecycle(2),
            }) as never,
          )
        }),
      })
      const contributions = yield* setupOf(ext)
      const loaded = {
        manifest: { id: ext.manifest.id },
        scope: "builtin",
        sourcePath: "builtin",
        contributions,
      } satisfies LoadedExtension
      yield* Effect.scoped(Layer.build(buildResourceLayer([loaded], "process")).pipe(Effect.asVoid))
      expect(log).toEqual(["startup-1", "startup-2", "shutdown-2", "shutdown-1"])
    }))

  test("register accumulates values per domain across calls", () =>
    Effect.gen(function* () {
      const namedTool = (id: string) =>
        tool({
          id,
          description: id,
          params: Schema.Struct({}),
          output: Schema.Void,
          execute: () => Effect.void,
        })
      const ext = defineExtension({
        id: "accumulates",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", namedTool("first"), namedTool("second"))
          yield* host.register("agent", testAgent)
          yield* host.register("tool", namedTool("third"))
        }),
      })
      const contributions = yield* setupOf(ext)
      expect(contributions.tools?.map((entry) => String(getToolId(entry)))).toEqual([
        "first",
        "second",
        "third",
      ])
      expect(contributions.agents?.map((agent) => agent.name)).toEqual([DEFAULT_AGENT_NAME])
    }))

  test("on records a hook slot with its kind", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "hook-kinds",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.on("turnAfter", () => Effect.void)
          yield* host.on("turnProjection", () =>
            Effect.succeed({ promptSections: [], policyFragments: [] }),
          )
          yield* host.on("systemPrompt", (input) => Effect.succeed(input.basePrompt))
        }),
      })
      const contributions = yield* setupOf(ext)
      expect(contributions.hooks?.map((slot) => slot.kind)).toEqual([
        "turnAfter",
        "turnProjection",
        "systemPrompt",
      ])
    }))

  test("setup sees cwd and home from the host", () =>
    Effect.gen(function* () {
      let captured: Option.Option<ExtensionHostService> = Option.none()
      const ext = defineExtension({
        id: "captures-host",
        setup: Effect.gen(function* () {
          captured = Option.some(yield* ExtensionHost)
        }),
      })
      yield* collectTestContributions(ext.setup, {
        cwd: "/work/project",
        home: "/work/home",
      })
      expect(Option.isSome(captured)).toBe(true)
      if (Option.isNone(captured)) return
      expect(captured.value.cwd).toBe("/work/project")
      expect(captured.value.home).toBe("/work/home")
      expect("spawner" in captured.value).toBe(false)
      expect("parentEnv" in captured.value.host).toBe(false)
      expect("signalPid" in captured.value.host).toBe(false)
      expect("runProcess" in captured.value.host).toBe(false)
      expect("randomId" in captured.value.host).toBe(false)
      expect("Process" in captured.value).toBe(false)
    }))

  test("defineExtension result wires through ExtensionRegistry + explicit prompt slots", () =>
    Effect.gen(function* () {
      const myTool = tool({
        id: "from-define",
        description: "test",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("hi"),
      })
      const ext = defineExtension({
        id: "wired",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", myTool)
          yield* host.on("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}!!`))
        }),
      })
      const contributions = yield* setupOf(ext)
      const loaded = {
        manifest: { id: ExtensionId.make("wired") },
        scope: "builtin",
        sourcePath: "/test/wired",
        contributions,
      } satisfies LoadedExtension
      const resolved = resolveExtensions([loaded])
      const resolvedTool = resolved.modelCapabilities.get("from-define")?.capability
      expect(resolvedTool).toBeDefined()
      if (Predicate.isUndefined(resolvedTool)) return
      expect(String(getToolId(resolvedTool))).toBe("from-define")

      const compiled = compileExtensionHooks([loaded])
      const result = yield* compiled
        .resolveSystemPrompt({ basePrompt: "yo", agent: testAgent })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx))
      expect(result).toBe("yo!!")
    }))

  test("setup failure surfaces as ExtensionLoadError", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "boom",
        setup: Effect.fail(
          new ExtensionLoadError({ extensionId: ExtensionId.make("boom"), message: "nope" }),
        ),
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("nope")
      }
    }))

  test("raw native Effect tools are rejected at package validation", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "raw-native",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "tool",
            // oxlint-disable-next-line effect/noAs -- This invalid native tool is deliberately injected to test rejection.
            AiTool.dynamic("raw_tool", {
              description: "native but missing Gent metadata",
              parameters: Schema.Unknown,
            }) as never,
          )
        }),
      })
      const contributions = yield* setupOf(ext)
      const exit = yield* Effect.exit(validateExtensionPackage(ext.manifest, contributions))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
        )
      }
    }))

  test("metadata-spoofed native Effect tools are rejected at package validation", () =>
    Effect.gen(function* () {
      const legit = tool({
        id: "legit",
        description: "legit",
        params: Schema.Unknown,
        output: Schema.Void,
        execute: () => Effect.void,
      })
      const ext = defineExtension({
        id: "metadata-spoof",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "tool",
            // oxlint-disable-next-line effect/noAs -- This metadata-spoofed native tool is deliberately injected to test rejection.
            AiTool.dynamic("spoofed_tool", {
              description: "native with copied Gent metadata but no private brand",
              parameters: Schema.Unknown,
            }).annotate(GentToolMetadataTag, getToolMetadata(legit)) as never,
          )
        }),
      })
      const contributions = yield* setupOf(ext)
      const exit = yield* Effect.exit(validateExtensionPackage(ext.manifest, contributions))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
        )
      }
    }))

  test("a model tool with a whitespace-only description is rejected at package validation", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateExtensionPackage(
          { id: ExtensionId.make("blank-desc") },
          {
            tools: [
              tool({
                id: "blanky",
                description: "   \t\n",
                params: Schema.Unknown,
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          },
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("tools[0] (blanky): tool requires a non-empty `description`")
      }
    }))

  test("a model tool with an empty description is rejected at package validation", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateExtensionPackage(
          { id: ExtensionId.make("missing-desc") },
          {
            tools: [
              tool({
                id: "describeless",
                description: "",
                params: Schema.Unknown,
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          },
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0] (describeless): tool requires a non-empty `description`",
        )
      }
    }))

  test("a request capability needs no description", () =>
    Effect.gen(function* () {
      // Requests never reach the LLM as a tool schema, so the description rule
      // does not apply to them.
      const exit = yield* Effect.exit(
        validateExtensionPackage(
          { id: ExtensionId.make("rpc-no-desc") },
          {
            requests: [
              request({
                id: "internal",
                input: Schema.Struct({}),
                output: Schema.String,
                execute: () => Effect.succeed("ok"),
              }),
            ],
          },
        ),
      )
      expect(exit._tag).toBe("Success")
    }))

  test("an old bucket key on defineExtension fails setup with a migration message", () =>
    Effect.gen(function* () {
      const extension = defineExtension<never>(
        // oxlint-disable-next-line effect/noAs -- This old-contract input is a runtime rejection fixture.
        { id: "old-buckets", setup: Effect.void, tools: [] } as never,
      )
      const exit = yield* Effect.exit(extension.setup)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain('unknown defineExtension key "tools"')
        expect(rendered).toContain("ExtensionHost")
      }
    }))

  test("unknown runtime-loaded contribution buckets fail activation", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateExtensionPackage(
          { id: ExtensionId.make("unknown-bucket") },
          // oxlint-disable-next-line effect/noAs -- This invalid bucket is a runtime package-shape rejection fixture.
          {
            actors: [],
          } as never,
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("unknown contribution bucket")
        expect(rendered).toContain("actors")
      }
    }))

  test("runtime-loaded resources require a non-empty id", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateExtensionPackage(
          { id: ExtensionId.make("invalid-resource-metadata") },
          // oxlint-disable-next-line effect/noAs -- This malformed resource is a runtime package-shape rejection fixture.
          {
            resources: [
              {
                scope: "process",
                layer: Layer.empty,
              },
            ],
          } as never,
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("resources[0]: resource requires a non-empty id")
      }
    }))

  test("duplicate request ids report the public bucket name", () =>
    Effect.gen(function* () {
      const duplicate = (id: string) =>
        request({
          id,
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
        })

      const exit = yield* validateExtensionPackage(
        { id: ExtensionId.make("duplicate-requests") },
        {
          requests: [duplicate("same"), duplicate("same")],
        },
      ).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("requests[1] (same)")
        expect(rendered).not.toContain("rpc[")
      }
    }))

  test("defineExtension preserves contribution buckets", () =>
    Effect.gen(function* () {
      const readSnapshot = request({
        id: "read-snapshot",
        input: Schema.Struct({}),
        output: Schema.Finite,
        execute: () => Effect.succeed(1),
      })
      const toolExt = defineExtension({
        id: "helper-tool",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "tool",
            tool({
              id: "helper-tool-call",
              description: "helper tool",
              params: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.succeed("ok"),
            }),
          )
        }),
      })
      const rpcExt = defineExtension({
        id: "helper-rpc",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("request", readSnapshot)
        }),
      })
      const toolContribs = yield* setupOf(toolExt)
      const requestContribs = yield* setupOf(rpcExt)

      expect(toolContribs.tools?.map((t) => String(getToolId(t)))).toEqual(["helper-tool-call"])
      expect(requestContribs.requests?.map((r) => String(r.id))).toEqual(["read-snapshot"])
    }))
})
