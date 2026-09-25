import { describe, expect, it, test } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Predicate, Schema, Context } from "effect"
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
  CapabilityError,
  ExtensionContext,
  runProcess,
  type RequestInput,
  type ToolInput,
} from "@gent/core/extensions/api"
import { ExtensionId } from "../../src/domain/ids"
import { GentToolMetadataTag, getToolMetadata } from "../../src/domain/capability"
import {
  ExtensionLoadError,
  type LoadedExtension,
  validateExtensionPackage,
  type AnyExtensionHook,
} from "../../src/domain/extension"
import {
  buildScopeResources,
  compileExtensionHooks,
  CurrentExtensionHostContext,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import { collectTestContributions, testExtensionHostContext } from "../../src/test-utils/harness"
import * as AiTool from "effect/unstable/ai/Tool"
import { testAgent } from "../helpers/test-preset"
import { DEFAULT_AGENT_NAME } from "../../src/domain/agent"

import type { ChildProcessSpawner } from "effect/unstable/process"
import type * as PublicExtensionApi from "@gent/core/extensions/api"

// ── define extension ────────────────────────────────────────────────────────

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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* buildScopeResources({
            extensions: [loaded],
            scope: "process",
            context: Context.makeUnsafe<unknown>(new Map()),
            parent: yield* Effect.scope,
            restore: (effect) => effect,
          })
          expect(started.failed).toEqual([])
        }),
      )
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

// ── authoring surface locks (compile-time) ───────────────────────────────────

/**
 * Extension surface regression locks (compile-time).
 *
 * One intentional lock pack for the public extension authoring surface:
 * 1. capability factory shapes stay honest
 * 2. Promise handlers stay out of Effect-returning seams
 * 3. ExtensionContext stays the single host-authority import; files,
 *    paths, processes, and ids are the Effect platform services themselves
 *
 * Runtime composition has separate behavior tests; this file only locks the
 * public extension authoring surface.
 */

class WriteCapableService extends Context.Service<
  WriteCapableService,
  { readonly write: Effect.Effect<void> }
>()("@gent/core/tests/extensions/api.test/WriteCapableService") {}

interface ReadOnlyApi {
  readonly read: Effect.Effect<string>
}

class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnlyApi>()(
  "@gent/core/tests/extensions/api.test/ReadOnlyService",
) {}

const NoInput = Schema.Struct({})
const StringOutput = Schema.String

describe("Capability factory-shape locks (compile-time)", () => {
  test("tool({...}) — happy path compiles", () => {
    const ok = tool({
      id: "ok-tool",
      description: "ok",
      params: Schema.Struct({ x: Schema.String }),
      output: Schema.String,
      execute: (params) => Effect.succeed(`ok: ${params.x}`),
    })
    void ok
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `surface` field — slash presentation belongs on request()", () => {
    const badInput = {
      id: "bad-tool",
      description: "x",
      params: NoInput,
      output: StringOutput,
      // @ts-expect-error — `surface` is not part of the public tool authoring surface
      surface: "slash",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput

    void badInput
    expect(true).toBe(true)
  })

  test("tool({...}) execute receives params only; host facts come from ExtensionContext", () => {
    tool({
      id: "minimal-tool-context",
      description: "ok",
      params: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          void ctx.sessionId
          void ctx.branchId
          void ctx.toolCallId
          void ctx.Session
          return "ok"
        }),
    })

    expect(true).toBe(true)
  })

  test("state change notifications use the current ExtensionContext identity", () => {
    type StateChanged = PublicExtensionApi.ExtensionContextService["State"]["changed"]

    const good: Parameters<StateChanged> = []

    // @ts-expect-error — extension identity is supplied by ExtensionContext, not a parameter
    const bad: Parameters<StateChanged> = [{ extensionId: ExtensionId.make("surface-locks") }]

    void good
    void bad
    expect(true).toBe(true)
  })

  test("request({...}) — happy path compiles with ordinary Effect services", () => {
    const ok = request({
      id: "ok-read",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* ReadOnlyService
          return yield* svc.read
        }),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request({...}) may yield ExtensionContext", () => {
    const ok = request({
      id: "read-context",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          return ctx.cwd
        }),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request({...}) — write-capable Tag in R is allowed", () => {
    const ok = request({
      id: "ok-write",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write
          return "x"
        }),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request handlers receive params only", () => {
    const bad: RequestInput<{}, string> = {
      id: "write-core-context",
      input: NoInput,
      output: StringOutput,
      // @ts-expect-error — request handlers receive decoded params only; host access comes from ExtensionContext
      execute: (_input, _ctx) => Effect.succeed("ok"),
    }
    void bad
    expect(true).toBe(true)
  })

  test("write request host authority is imported as ExtensionContext service", () => {
    request({
      id: "write-privileged-context",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          yield* ctx.Session.send({ delivery: "queue", sourceId: "lock", content: "x" })
          return "ok"
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CapabilityError({
                extensionId: ExtensionId.make("surface-locks"),
                capabilityId: "write-privileged-context",
                reason: cause.message,
              }),
          ),
        ),
    })
    expect(true).toBe(true)
  })

  test("request({...}) accepts slash presentation metadata", () => {
    const ok = request({
      id: "ok-slash-request",
      slash: {
        name: "Ok Slash",
        description: "Visible over transport command listing",
        category: "Test",
        keybind: "ctrl+o",
      },
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request({...}) rejects `params` field (tool-only)", () => {
    const badInput = {
      id: "bad-request",
      // @ts-expect-error — `params` belongs to tool(), not request()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    } satisfies RequestInput<unknown, string, never>

    void badInput
    expect(true).toBe(true)
  })

  test("action factory and ActionCapability/ActionInput/ActionSurface are not part of the public API", () => {
    // @ts-expect-error — `action(...)` factory was collapsed into `request({...slash: {...}})`
    type _BadAction = typeof PublicExtensionApi.action
    // @ts-expect-error — ActionCapability type was removed; slash-presented capabilities are RequestCapability
    type _BadActionCapability = PublicExtensionApi.ActionCapability
    // @ts-expect-error — ActionInput type was removed; authors use RequestInput
    type _BadActionInput = PublicExtensionApi.ActionInput
    // @ts-expect-error — ActionSurface was removed; slash presentation lives on `request({slash:...})`
    type _BadActionSurface = PublicExtensionApi.ActionSurface
    expect(true).toBe(true)
  })
})

describe("Effect-purity locks (compile-time)", () => {
  test("tool.execute MUST return Effect — Promise handler rejected", () => {
    const promiseString = Bun.file("/dev/null").text() // oxlint-disable-line effect/noGlobals -- This host call creates a Promise solely for the compile-time rejection lock.
    tool({
      id: "ok",
      description: "ok",
      params: Schema.Struct({}),
      output: Schema.String,
      // @ts-expect-error — Promise handler must not be assignable to Effect-returning execute
      execute: () => promiseString,
    })
    expect(true).toBe(true)
  })

  test("tool needs are not part of the public authoring surface", () => {
    tool({
      id: "bad-read-tool",
      description: "bad",
      // @ts-expect-error — tools import services instead of declaring read/write needs
      needs: [{ tag: "todo", access: "write" }],
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("request handlers receive decoded input only", () => {
    const bad: RequestInput<{}, void, never> = {
      id: "default-request-context",
      input: Schema.Struct({}),
      output: Schema.Void,
      // @ts-expect-error — request handlers receive decoded input only; host access comes from ExtensionContext
      execute: (_input, _ctx) => Effect.void,
    }
    void bad
    expect(true).toBe(true)
  })

  test("session follow-up authority is imported through ExtensionContext", () => {
    defineExtension({
      id: "queue-follow-up-compile-lock",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "request",
          request({
            id: "queue-follow-up",
            slash: { name: "Queue Follow Up", description: "ok" },
            input: Schema.Struct({}),
            output: Schema.Void,
            execute: () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* ctx.Session.send({ delivery: "queue", sourceId: "lock", content: "x" })
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CapabilityError({
                      extensionId: ExtensionId.make("queue-follow-up-compile-lock"),
                      capabilityId: "queue-follow-up",
                      reason: cause.message,
                    }),
                ),
              ),
          }),
        )
        yield* host.on("turnAfter", (_input: PublicExtensionApi.TurnAfterInput) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            void ctx.Session.send
          }),
        )
      }),
    })

    expect(true).toBe(true)
  })

  test("removed hook slots are not part of the public hooks bag", () => {
    type HookKind = AnyExtensionHook["kind"]
    // @ts-expect-error — messageInput hook was removed; mutations belong in tools/requests
    const messageInput: HookKind = "messageInput"
    // @ts-expect-error — contextMessages hook was removed; turnProjection composes prompt context
    const contextMessages: HookKind = "contextMessages"
    // @ts-expect-error — permissionCheck hook was removed; permission policy is host-owned
    const permissionCheck: HookKind = "permissionCheck"
    // @ts-expect-error — toolExecute hook was removed; tools own their effect
    const toolExecute: HookKind = "toolExecute"
    // @ts-expect-error — turnBefore hook was removed; turnProjection runs at turn start
    const turnBefore: HookKind = "turnBefore"
    // @ts-expect-error — messageOutput hook was removed; assistant parts persist directly
    const messageOutput: HookKind = "messageOutput"
    void messageInput
    void contextMessages
    void permissionCheck
    void toolExecute
    void turnBefore
    void messageOutput
    expect(true).toBe(true)
  })

  test("reactions bucket is not part of the public extension input", () => {
    defineExtension({
      id: "deleted-reactions-bucket-lock",
      setup: Effect.void,
      // @ts-expect-error — lifecycle authoring uses host.on; reactions was deleted
      reactions: {},
    })
    expect(true).toBe(true)
  })

  test("hook handler field shape is locked to handler-only", () => {
    type TurnAfterSlot = Extract<AnyExtensionHook, { readonly kind: "turnAfter" }>
    // @ts-expect-error — failureMode field was removed; runtime always isolates hook failures
    type _FailureMode = TurnAfterSlot["hook"]["failureMode"]
    expect(true).toBe(true)
  })

  test("ExtensionContext carries no facet for an Effect platform service", () => {
    type Ctx = PublicExtensionApi.ExtensionContextService
    // @ts-expect-error — the Files facet was removed; extensions yield FileSystem.FileSystem and Path.Path
    type _Files = Ctx["Files"]
    // @ts-expect-error — the Process facet was removed; extensions run commands over ChildProcessSpawner and mint ids with Crypto
    type _Process = Ctx["Process"]
    expect(true).toBe(true)
  })

  test("ExtensionContext.Session exposes queries only — no branch/session/message mutations", () => {
    type SessionService = PublicExtensionApi.ExtensionContextService["Session"]
    // @ts-expect-error — createBranch was removed; branch mutations route through the RPC client
    type _CreateBranch = SessionService["createBranch"]
    // @ts-expect-error — forkBranch was removed; branch mutations route through the RPC client
    type _ForkBranch = SessionService["forkBranch"]
    // @ts-expect-error — switchBranch was removed; branch mutations route through the RPC client
    type _SwitchBranch = SessionService["switchBranch"]
    // @ts-expect-error — createChildSession was removed; session-tree mutations route through the RPC client
    type _CreateChildSession = SessionService["createChildSession"]
    // @ts-expect-error — getChildSessions was removed; session-tree reads route through the RPC client
    type _GetChildSessions = SessionService["getChildSessions"]
    // @ts-expect-error — getSessionAncestors was removed; session-tree reads route through the RPC client
    type _GetSessionAncestors = SessionService["getSessionAncestors"]
    // @ts-expect-error — deleteSession was removed; deletion routes through the RPC client
    type _DeleteSession = SessionService["deleteSession"]
    // @ts-expect-error — deleteBranch was removed; deletion routes through the RPC client
    type _DeleteBranch = SessionService["deleteBranch"]
    // @ts-expect-error — deleteMessages was removed; message mutations route through the RPC client
    type _DeleteMessages = SessionService["deleteMessages"]
    expect(true).toBe(true)
  })

  test("hook handlers receive event input only", () => {
    defineExtension({
      id: "hook-handler-params-lock",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.on(
          "turnAfter",
          // @ts-expect-error — host authority comes from ExtensionContext, not a ctx parameter
          (_input: PublicExtensionApi.TurnAfterInput, _ctx: unknown) => Effect.void, // oxlint-disable-line effect/noUnknownParameters -- This invalid contract deliberately checks that a ctx parameter is rejected.
        )
      }),
    })
    expect(true).toBe(true)
  })

  test("private host and storage shapes stay out of the public API", () => {
    // @ts-expect-error — raw host context is runtime plumbing; authors use typed handlers
    type _BadHostContext = PublicExtensionApi.ExtensionHostContext
    // @ts-expect-error — storage-layer errors are not public extension authoring API
    type _BadStorageError = PublicExtensionApi.StorageError
    // @ts-expect-error — storage-layer search rows are not public extension authoring API
    type _BadStorageSearchResult = PublicExtensionApi.SearchResult
    // @ts-expect-error — generic capability token is internal; authors use concrete leaf factories
    type _BadCapabilityToken = PublicExtensionApi.CapabilityToken
    // @ts-expect-error — resource-need labels are extension-authored, not centrally registered by core
    type _BadLockRegistry = typeof PublicExtensionApi.LOCK_REGISTRY
    // @ts-expect-error — generic capability contribution is internal; authors use concrete leaf factories
    type _BadCapabilityContribution = PublicExtensionApi.CapabilityContribution
    // @ts-expect-error — generic capability contribution is internal; authors use concrete leaf factories
    type _BadAnyCapabilityContribution = PublicExtensionApi.AnyCapabilityContribution
    // @ts-expect-error — audience flags are internal lowering details, not public authoring API
    type _BadAudience = PublicExtensionApi.Audience
    // @ts-expect-error — read/write intent is not public request authoring API
    type _BadIntent = PublicExtensionApi.Intent
    // @ts-expect-error — model tool metadata is internal lowering detail
    type _BadModelAudienceFields = PublicExtensionApi.ModelAudienceFields
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadToolMetadataTag = typeof PublicExtensionApi.GentToolMetadataTag
    // @ts-expect-error — tool execution ctx is runtime plumbing; authors yield ExtensionContext
    type _BadToolCoreContext = PublicExtensionApi.ToolCoreContext
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionSession = typeof PublicExtensionApi.ExtensionSession
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionAgent = typeof PublicExtensionApi.ExtensionAgent
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionInteraction = typeof PublicExtensionApi.ExtensionInteraction
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionProcess = typeof PublicExtensionApi.ExtensionProcess
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionFiles = typeof PublicExtensionApi.ExtensionFiles
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionFileLock = typeof PublicExtensionApi.ExtensionFileLock
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadGetToolMetadata = typeof PublicExtensionApi.getToolMetadata
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadIsToolCapability = typeof PublicExtensionApi.isToolCapability
    // @ts-expect-error — package shape validation is host loader plumbing, not authoring API
    type _BadValidateExtensionPackage = typeof PublicExtensionApi.validateExtensionPackage
    // @ts-expect-error — request refs are read via ref(...); the symbol stays private
    type _BadCapabilityRefSymbol = typeof PublicExtensionApi.CAPABILITY_REF
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadReadOnlyBrand = typeof PublicExtensionApi.ReadOnlyBrand
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadWithReadOnly = typeof PublicExtensionApi.withReadOnly
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadReadOnly = PublicExtensionApi.ReadOnly<ReadOnlyApi>
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadReadOnlyTag = PublicExtensionApi.ReadOnlyTag
    expect(true).toBe(true)
  })

  test("public extension api does not expose runtime engine tags or server routers", () => {
    // @ts-expect-error — machine execution is not authoring surface
    type _BadMachineExecute = PublicExtensionApi.MachineExecute
    // @ts-expect-error — interaction pending reader is a storage seam, not authoring api
    type _BadInteractionPendingReader = PublicExtensionApi.InteractionPendingReader
    // @ts-expect-error — event publisher is an app/domain service, not extension api
    type _BadEventPublisher = PublicExtensionApi.EventPublisher
    expect(true).toBe(true)
  })

  test("public extension api does not expose host extension-loading helpers", () => {
    // @ts-expect-error — disabled-extension config loading is host UI plumbing
    type _BadReadDisabledExtensions = typeof PublicExtensionApi.readDisabledExtensions
    // @ts-expect-error — ToolRunner is runtime engine plumbing
    type _BadToolRunner = typeof PublicExtensionApi.ToolRunner
    // @ts-expect-error — external turn executors are removed; a driver is a model driver
    type _BadExternalToolRunner = typeof PublicExtensionApi.ExternalToolRunner
    // @ts-expect-error — external turn executors are removed; a driver is a model driver
    type _BadExternalDriverRef = typeof PublicExtensionApi.ExternalDriverRef
    // @ts-expect-error — todo lifecycle events are private; extensions publish state pulses
    type _BadTodoCreated = typeof PublicExtensionApi.TodoCreated
    // @ts-expect-error — todo schemas belong to @gent/todo, not core author API
    type _BadTodo = typeof PublicExtensionApi.Todo
    // @ts-expect-error — todo ids belong to @gent/todo, not core author API
    type _BadTodoId = typeof PublicExtensionApi.TodoId
    // @ts-expect-error — host platform is internal authority; public extensions use ExtensionContext facets
    type _BadGentPlatform = typeof PublicExtensionApi.GentPlatform
    // @ts-expect-error — platform live layers are composition-root plumbing
    type _BadBunGentPlatformLive = typeof PublicExtensionApi.BunGentPlatformLive
    // @ts-expect-error — host signal errors pair with the internal platform service
    type _BadSignalError = typeof PublicExtensionApi.SignalError
    // @ts-expect-error — durable message metadata schema is storage/runtime internals
    type _BadMessageMetadata = typeof PublicExtensionApi.MessageMetadata
    // @ts-expect-error — host-context errors are runtime internals, not authoring API
    type _BadExtensionHostError = typeof PublicExtensionApi.ExtensionHostError
    // The event type is public (an extension reads its own branch's stream);
    // the constructors are not, so raw runtime events cannot be forged.
    type _AgentEventType = PublicExtensionApi.AgentEvent
    const forgeAgentEvent = () => {
      // @ts-expect-error — raw runtime event constructors can forge product state
      void PublicExtensionApi.AgentEvent
    }
    void forgeAgentEvent
    // @ts-expect-error — transport event envelopes are SDK/TUI plumbing, not authoring API
    type _BadEventEnvelope = PublicExtensionApi.EventEnvelope
    // @ts-expect-error — interaction wire state is client/runtime plumbing
    type _BadActiveInteraction = PublicExtensionApi.ActiveInteraction
    // @ts-expect-error — the raw host platform is loop plumbing; authors read setup facts on host.host
    type _BadExtensionHostPlatform = PublicExtensionApi.ExtensionHostPlatform
    // @ts-expect-error — the host process error was removed with the Process facet; runProcess fails with ProcessError
    type _BadExtensionHostProcessError = typeof PublicExtensionApi.ExtensionHostProcessError
    // @ts-expect-error — host file lock Tag is private; extensions reach file locks through ExtensionContext.FileLock
    type _BadFileLockService = typeof PublicExtensionApi.FileLockService
    // @ts-expect-error — capability access enforcement is runtime lowering, not author API
    type _BadRequireCapabilityWrite = typeof PublicExtensionApi.requireCapabilityWrite

    expect(true).toBe(true)
  })

  test("read request handlers do not receive host facts by parameter", () => {
    const bad: RequestInput<{}, string> = {
      id: "facts-only-read",
      input: Schema.Struct({}),
      output: Schema.String,
      // @ts-expect-error — request handlers receive decoded params only; facts come from ExtensionContext/setup context
      execute: (_input, _ctx) => Effect.succeed("ok"),
    }
    void bad
    expect(true).toBe(true)
  })

  test("GentExtension.setup is an Effect value, not a thunk receiving ctx", () => {
    type SetupField = PublicExtensionApi.GentExtension["setup"]
    // Setup must be assignable from a value (an Effect), not from a `() => Effect`.
    const okValue: SetupField = Effect.void
    void okValue
    // @ts-expect-error — `setup` is no longer a thunk; ctx-as-param escape was removed
    const badThunk: SetupField = (_ctx: unknown) => Effect.void // oxlint-disable-line effect/noUnknownParameters -- This invalid contract deliberately checks that setup is not a ctx thunk.
    void badThunk
    // @ts-expect-error — `setup` is no longer a thunk; zero-arg thunks are also rejected
    const badZeroArg: SetupField = () => Effect.void
    void badZeroArg
    expect(true).toBe(true)
  })

  test("setup host exposes host facts on host.host and no process facade", () => {
    const setup = Effect.gen(function* () {
      const host = yield* ExtensionHost
      const platform = host.host.osInfo.platform
      const home = host.host.homeDirectory
      const cwd = host.cwd
      // @ts-expect-error — setup does not see its source path
      void host.source
      // @ts-expect-error — setup has no process facade; commands run over ChildProcessSpawner
      void host.Process
      // @ts-expect-error — host facts do not carry the parent process env
      void host.host.parentEnv
      // @ts-expect-error — host facts cannot signal host processes
      void host.host.signalPid
      // @ts-expect-error — host facts cannot spawn host processes
      host.host.runProcess("git", ["status"])
      return `${platform}:${home.length}:${cwd}`
    })
    void setup
    expect(true).toBe(true)
  })

  test("tool authoring uses ExtensionContext instead of a ctx parameter", () => {
    tool({
      id: "facts-only-tool",
      description: "facts",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          return ctx.cwd
        }),
    })
    expect(true).toBe(true)
  })

  test("a command runs over the Effect ChildProcessSpawner", () => {
    const run = runProcess("git", ["status"])
    const withSpawner: Effect.Effect<
      { readonly exitCode: number },
      PublicExtensionApi.ProcessError,
      ChildProcessSpawner.ChildProcessSpawner
    > = run
    void withSpawner
    expect(true).toBe(true)
  })

  test("hooks.systemPrompt MUST return Effect — Promise handler rejected", () => {
    const promiseString = Bun.file("/dev/null").text() // oxlint-disable-line effect/noGlobals -- This host call creates a Promise solely for the compile-time rejection lock.
    defineExtension({
      id: "bad-prompt-hook",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        // @ts-expect-error — Promise handler must not be assignable to Effect-returning systemPrompt
        yield* host.on("systemPrompt", () => promiseString)
      }),
    })
    expect(true).toBe(true)
  })

  test("extension hooks and resource layers reject Promise values", () => {
    // gent/no-sleep: allow source a `Promise<void>` value purely for type-level assignability check below
    const promiseVoid = Bun.sleep(0) // oxlint-disable-line effect/noGlobals -- This host call creates a Promise solely for the compile-time rejection lock.
    defineExtension({
      id: "purity-hook",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        // @ts-expect-error — Promise handler must not be assignable to Effect-returning extension hook
        yield* host.on("turnAfter", () => promiseVoid)
      }),
    })
    defineResource({
      id: "test/extension-surface-locks/layer-promise",
      scope: "process",
      // @ts-expect-error — Promise must not be assignable to a Resource layer
      layer: promiseVoid,
    })
    expect(true).toBe(true)
  })

  test("valid Effect-based extension lowering still compiles", () => {
    const ext = defineExtension({
      id: "purity-positive",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "tool",
          tool({
            id: "noop",
            description: "noop",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.succeed("ok"),
          }),
        )
        yield* host.on("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}suffix`))
        yield* host.on("turnAfter", () => Effect.void)
        yield* host.register(
          "resource",
          defineResource({
            id: "test/extension-surface-locks/valid-resource",
            scope: "process",
            layer: Layer.succeed(ReadOnlyService, {
              read: Effect.succeed(""),
            } satisfies ReadOnlyApi),
          }),
        )
      }),
    })

    expect(String(ext.manifest.id)).toBe("purity-positive")
  })
})
