/**
 * Extension surface regression locks (compile-time).
 *
 * One intentional lock pack for the public extension authoring surface:
 * 1. capability factory shapes stay honest
 * 2. Promise/async handlers stay out of Effect-returning seams
 * 3. projection read-only fences reject write-capable service tags
 *
 * `scope-brands.test.ts` stays separate because it proves actor/runtime
 * ownership rather than extension surface typing.
 */

import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import type * as PublicExtensionApi from "@gent/core/extensions/api"
import {
  action,
  defineExtension,
  defineResource,
  type ProjectionContribution,
  ProjectionError,
  type ReadOnly,
  ReadOnlyBrand,
  type ReadOnlyTag,
  type ReadRequestInput,
  type ExtensionHostContext,
  makeRunSpec,
  request,
  resource,
  tool,
  ToolCallId,
  type ToolInput,
  type WriteRequestInput,
} from "@gent/core/extensions/api"

class WriteCapableService extends Context.Service<
  WriteCapableService,
  { readonly write: () => Effect.Effect<void> }
>()("@gent/core/tests/extension-surface-locks/WriteCapableService") {}

interface ReadOnlyShape {
  readonly read: () => Effect.Effect<string>
}

class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnly<ReadOnlyShape>>()(
  "@gent/core/tests/extension-surface-locks/ReadOnlyService",
) {
  declare readonly [ReadOnlyBrand]: true
}

void ReadOnlyBrand

const NoInput = Schema.Struct({})
const StringOutput = Schema.String

describe("Capability factory-shape locks (compile-time)", () => {
  test("makeRunSpec requires branded tool-call provenance", () => {
    const ok = makeRunSpec({ parentToolCallId: ToolCallId.of("tc-ok") })

    // @ts-expect-error — raw strings are not valid tool-call provenance
    const bad = makeRunSpec({ parentToolCallId: "tc-raw" })

    void ok
    void bad
    expect(true).toBe(true)
  })

  test("tool({...}) — happy path compiles", () => {
    const ok = tool({
      id: "ok-tool",
      description: "ok",
      params: Schema.Struct({ x: Schema.String }),
      execute: (params) => Effect.succeed(`ok: ${params.x}`),
    })
    void ok
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `surface` field (action-only)", () => {
    const badInput = {
      id: "bad-tool",
      description: "x",
      params: NoInput,
      // @ts-expect-error — `surface` is an action-only field
      surface: "slash",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput

    void badInput
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `intent` field (request-only)", () => {
    const badInput = {
      id: "bad-tool",
      description: "x",
      params: NoInput,
      // @ts-expect-error — `intent` is a request-only field
      intent: "read",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput

    void badInput
    expect(true).toBe(true)
  })

  test("request({ intent: 'read' }) — happy path compiles with ReadOnly Tag", () => {
    const ok = request({
      id: "ok-read",
      intent: "read",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* ReadOnlyService
          return yield* svc.read()
        }),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request({ intent: 'read' }) rejects write-capable Tag in R", () => {
    const badInput = {
      id: "bad-read",
      intent: "read" as const,
      input: NoInput,
      output: StringOutput,
      execute: () =>
        // @ts-expect-error — WriteCapableService lacks ReadOnlyBrand
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return "x"
        }),
    } satisfies ReadRequestInput<unknown, string, never>

    void badInput
    expect(true).toBe(true)
  })

  test("request({ intent: 'write' }) — write-capable Tag in R is allowed", () => {
    const ok = request({
      id: "ok-write",
      intent: "write",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return "x"
        }),
    })

    void ok
    expect(true).toBe(true)
  })

  test("request({...}) rejects `params` field (tool-only)", () => {
    const badInput = {
      id: "bad-request",
      intent: "write" as const,
      // @ts-expect-error — `params` belongs to tool(), not request()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    } satisfies WriteRequestInput<unknown, string, never>

    void badInput
    expect(true).toBe(true)
  })

  test("action({...}) — happy path compiles", () => {
    const ok = action({
      id: "ok-action",
      name: "Ok Action",
      description: "ok",
      surface: "slash",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("done"),
    })

    void ok
    expect(true).toBe(true)
  })

  test("action({...}) rejects tool-only or request-only fields and unknown surfaces", () => {
    action({
      id: "bad-action",
      name: "x",
      description: "x",
      surface: "slash",
      // @ts-expect-error — `params` belongs to tool(), not action()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    action({
      id: "bad-action-intent",
      name: "x",
      description: "x",
      surface: "slash",
      // @ts-expect-error — `intent` belongs to request(), not action()
      intent: "write",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    action({
      id: "bad-action-surface",
      name: "x",
      description: "x",
      // @ts-expect-error — surface is `"slash" | "palette" | "both"` only
      surface: "modal",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })
})

describe("Effect-purity locks (compile-time)", () => {
  test("tool.execute MUST return Effect — async handler rejected", () => {
    tool({
      id: "ok",
      description: "ok",
      params: Schema.Struct({}),
      // @ts-expect-error — async handler must not be assignable to Effect-returning execute
      execute: async () => "result",
    })
    expect(true).toBe(true)
  })

  test("tool context does not expose follow-up queue mutation", () => {
    const bad = (_ctx: ExtensionHostContext) =>
      // @ts-expect-error — follow-up queueing is internal runtime state, not author surface
      _ctx.session.queueFollowUp({ content: "x" })

    void bad
    expect(true).toBe(true)
  })

  test("public extension api rejects runtime-only resource machine effects", () => {
    // @ts-expect-error — resource-machine runtime effects are likewise internal-only
    type _BadResource = PublicExtensionApi.ResourceMachineEffect

    type PublicMachine = PublicExtensionApi.ResourceMachine<
      { readonly _tag: "Idle" },
      { readonly _tag: "Ping" }
    >
    type PublicAfterTransition = NonNullable<PublicMachine["afterTransition"]>
    type PublicAfterTransitionEffect = ReturnType<PublicAfterTransition>[number]
    // @ts-expect-error — QueueFollowUp is runtime-only and must not type-check for public machines
    const badEffect: PublicAfterTransitionEffect = { _tag: "QueueFollowUp", content: "x" }

    void badEffect
    expect(true).toBe(true)
  })

  test("public extension api does not expose runtime engine tags or server routers", () => {
    // @ts-expect-error — machine execution is a runtime seam, not authoring surface
    type _BadMachineExecute = PublicExtensionApi.MachineExecute
    // @ts-expect-error — machine write surface is runtime-internal
    type _BadMachineEngine = PublicExtensionApi.MachineEngine
    // @ts-expect-error — tool runner is runtime plumbing, not extension authoring api
    type _BadToolRunner = PublicExtensionApi.ToolRunner
    // @ts-expect-error — interaction pending reader is a storage seam, not authoring api
    type _BadInteractionPendingReader = PublicExtensionApi.InteractionPendingReader
    // @ts-expect-error — event publisher is an app/domain service, not extension api
    type _BadEventPublisher = PublicExtensionApi.EventPublisher

    expect(true).toBe(true)
  })

  test("Projection.systemPrompt MUST return Effect — async handler rejected", () => {
    defineExtension({
      id: "bad-projection",
      projections: [
        {
          id: "prompt",
          query: () => Effect.succeed("x"),
          // @ts-expect-error — async handler must not be assignable to Effect-returning systemPrompt
          systemPrompt: async (value, input) => `${input.basePrompt}${value}`,
        },
      ],
    })
    expect(true).toBe(true)
  })

  test("resource runtime reactions, subscriptions, and lifecycle hooks reject Promise handlers", () => {
    defineResource({
      scope: "process",
      layer: Layer.empty,
      runtime: {
        turnAfter: {
          failureMode: "isolate",
          // @ts-expect-error — async handler must not be assignable to Effect-returning runtime reaction
          handler: async () => undefined,
        },
      },
    })
    defineResource({
      scope: "process",
      layer: Layer.empty,
      subscriptions: [
        {
          pattern: "agent:*",
          // @ts-expect-error — async handler must not be assignable to Effect-returning bus handler
          handler: async () => undefined,
        },
      ],
    })
    defineResource({
      scope: "process",
      layer: Layer.empty,
      // @ts-expect-error — Promise must not be assignable to Effect Resource.start
      start: Promise.resolve(),
    })
    defineResource({
      scope: "process",
      layer: Layer.empty,
      // @ts-expect-error — Promise must not be assignable to Effect Resource.stop
      stop: Promise.resolve(),
    })
    expect(true).toBe(true)
  })

  test("valid Effect-based extension lowering still compiles", () => {
    const ext = defineExtension({
      id: "purity-positive",
      capabilities: [
        tool({
          id: "noop",
          description: "noop",
          params: Schema.Struct({}),
          execute: () => Effect.succeed("ok"),
        }),
      ],
      projections: [
        {
          id: "prompt",
          query: () => Effect.succeed("suffix"),
          systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
        },
      ],
      resources: [
        resource(
          defineResource({
            scope: "process",
            layer: Layer.empty,
            start: Effect.void,
            stop: Effect.void,
            runtime: {
              turnAfter: {
                failureMode: "continue",
                handler: () => Effect.void,
              },
            },
            subscriptions: [{ pattern: "agent:*", handler: () => Effect.void }],
            schedule: [
              {
                id: "j",
                cron: "0 0 * * *",
                target: { kind: "headless-agent", agent: "cowork" as never, prompt: "hi" },
              },
            ],
          }),
        ),
      ],
    })

    expect(ext.manifest.id).toBe("purity-positive")
  })
})

describe("Projection ReadOnly-brand locks (compile-time)", () => {
  test("Projection R must extend ReadOnlyTag — write-capable Tag rejected", () => {
    const ok: ProjectionContribution<{ value: string }, ReadOnlyService> = {
      id: "ok",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* ReadOnlyService
          const value = yield* svc.read()
          return { value }
        }),
    }
    void ok

    // @ts-expect-error — write-capable service tag fails the `R extends ReadOnlyTag` constraint
    const bad: ProjectionContribution<{ value: number }, WriteCapableService> = {
      id: "bad",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return { value: 1 }
        }).pipe(Effect.mapError(() => new ProjectionError({ projectionId: "bad", reason: "x" }))),
    }
    void bad

    expect(true).toBe(true)
  })

  test("Projection R = never compiles (no requirements is fine)", () => {
    const empty: ProjectionContribution<{ value: number }> = {
      id: "empty",
      query: () => Effect.succeed({ value: 0 }),
    }
    void empty
    expect(true).toBe(true)
  })

  test("Projection R must extend ReadOnlyTag — unbranded read service rejected", () => {
    interface UnbrandedShape {
      readonly get: () => Effect.Effect<string>
    }
    class UnbrandedService extends Context.Service<UnbrandedService, UnbrandedShape>()(
      "@gent/core/tests/extension-surface-locks/UnbrandedService",
    ) {}

    // @ts-expect-error — Tag identifier lacks the `ReadOnlyTag` brand
    const bad: ProjectionContribution<{ value: string }, UnbrandedService> = {
      id: "bad-unbranded",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* UnbrandedService
          const value = yield* svc.get()
          return { value }
        }),
    }
    void bad

    expect(true).toBe(true)
  })
})

type AssertReadOnlyExtendsTag = ReadOnly<ReadOnlyShape> extends ReadOnlyTag ? true : false
const readOnlyExtendsTag: AssertReadOnlyExtendsTag = true
void readOnlyExtendsTag

describe("Projection ReadOnly-brand locks — defineExtension boundary", () => {
  test("inline projections in defineExtension stay fenced", () => {
    const ok = defineExtension({
      id: "@gent/test/readonly-locks-ok",
      projections: [
        {
          id: "ok-inline",
          query: () =>
            Effect.gen(function* () {
              const svc = yield* ReadOnlyService
              const value = yield* svc.read()
              return { value }
            }),
        },
      ],
      resources: [{ scope: "process", layer: Layer.empty as Layer.Layer<unknown> }],
    })
    void ok

    const bad = defineExtension({
      id: "@gent/test/readonly-locks-bad",
      projections: [
        {
          id: "bad-inline",
          query: () =>
            // @ts-expect-error — write-capable Tag fails the contextual `ReadOnlyTag` fence
            Effect.gen(function* () {
              const svc = yield* WriteCapableService
              yield* svc.write()
              return { value: 1 }
            }).pipe(
              Effect.mapError(
                () => new ProjectionError({ projectionId: "bad-inline", reason: "x" }),
              ),
            ),
        },
      ],
      resources: [{ scope: "process", layer: Layer.empty as Layer.Layer<unknown> }],
    })
    void bad

    expect(true).toBe(true)
  })
})
