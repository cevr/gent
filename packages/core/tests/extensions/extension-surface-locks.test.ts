/**
 * Extension surface regression locks (compile-time).
 *
 * One intentional lock pack for the public extension authoring surface:
 * 1. capability factory shapes stay honest
 * 2. Promise/async handlers stay out of Effect-returning seams
 * 3. read-only branding remains available for request/reaction service seams
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
  ExtensionId,
  type ReadOnly,
  ReadOnlyBrand,
  type ReadOnlyTag,
  type ReadRequestInput,
  type ExtensionHostContext,
  ExtensionHostError,
  ExtensionHostSearchResult,
  makeRunSpec,
  request,
  resource,
  BranchId,
  SessionId,
  tool,
  ToolCallId,
  type ToolInput,
  type WriteRequestInput,
} from "@gent/core/extensions/api"
import type { SearchResult as StorageSearchResult } from "../../src/storage/search-storage"
import { StorageError } from "../../src/storage/sqlite-storage"

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
    const ok = makeRunSpec({ parentToolCallId: ToolCallId.make("tc-ok") })

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

  test("request({ intent: 'read' }) — happy path compiles with ReadOnly Tag", () => {
    const ok = request({
      id: "ok-read",
      extensionId: ExtensionId.make("test-ext"),
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
      extensionId: ExtensionId.make("test-ext"),
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
      extensionId: ExtensionId.make("test-ext"),
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

  test("request({...}) accepts slash presentation metadata", () => {
    const ok = request({
      id: "ok-slash-request",
      extensionId: ExtensionId.make("test-ext"),
      intent: "write",
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
      extensionId: ExtensionId.make("test-ext"),
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

  test("action({...}) rejects public transport exposure", () => {
    action({
      id: "bad-public-action",
      name: "x",
      description: "x",
      surface: "slash",
      // @ts-expect-error — public transport exposure belongs on slash-decorated request()
      public: true,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
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

  test("session.queueFollowUp is exposed for slot handlers and extension authors", () => {
    const ok = (_ctx: ExtensionHostContext) => _ctx.session.queueFollowUp({ content: "x" })

    void ok
    expect(true).toBe(true)
  })

  test("host session facet exposes host-domain errors/results, not storage types", () => {
    type MethodReturn<T> = T extends (...args: infer _Args) => infer R ? R : never
    type EffectSuccess<T> =
      MethodReturn<T> extends Effect.Effect<infer A, unknown, unknown> ? A : never
    type EffectError<T> =
      MethodReturn<T> extends Effect.Effect<unknown, infer E, unknown> ? E : never
    type SessionErrors = {
      readonly [K in keyof ExtensionHostContext.SessionFacet]: EffectError<
        ExtensionHostContext.SessionFacet[K]
      >
    }[keyof ExtensionHostContext.SessionFacet]
    type SearchResult = EffectSuccess<ExtensionHostContext.SessionFacet["search"]>

    const error: SessionErrors = new ExtensionHostError({
      operation: "session.search",
      message: "failed",
    })
    const result = ExtensionHostSearchResult.make({
      sessionId: SessionId.make("session-id"),
      sessionName: null,
      branchId: BranchId.make("branch-id"),
      snippet: "match",
      createdAt: 1,
    }) satisfies SearchResult[number]
    const storageResult: StorageSearchResult = {
      sessionId: "session-id",
      sessionName: null,
      branchId: "branch-id",
      snippet: "match",
      createdAt: 1,
    }

    // @ts-expect-error — storage-layer errors are not public extension authoring API
    type _BadStorageError = PublicExtensionApi.StorageError
    // @ts-expect-error — storage-layer search rows are not public extension authoring API
    type _BadStorageSearchResult = PublicExtensionApi.SearchResult
    // @ts-expect-error — generic capability substrate is internal; authors use concrete leaf factories
    type _BadCapabilityToken = PublicExtensionApi.CapabilityToken
    // @ts-expect-error — generic capability substrate is internal; authors use concrete leaf factories
    type _BadCapabilityContribution = PublicExtensionApi.CapabilityContribution
    // @ts-expect-error — generic capability substrate is internal; authors use concrete leaf factories
    type _BadAnyCapabilityContribution = PublicExtensionApi.AnyCapabilityContribution
    // @ts-expect-error — audience flags are internal lowering details, not public authoring API
    type _BadAudience = PublicExtensionApi.Audience
    // @ts-expect-error — request/tool factory inputs own their intent shape
    type _BadIntent = PublicExtensionApi.Intent
    // @ts-expect-error — model-audience metadata is internal lowering detail
    type _BadModelAudienceFields = PublicExtensionApi.ModelAudienceFields
    // @ts-expect-error — request refs are read via ref(...); the symbol stays private
    type _BadCapabilityRefSymbol = typeof PublicExtensionApi.CAPABILITY_REF
    // @ts-expect-error — all session facet methods must map storage failures to host errors
    const badSessionError: SessionErrors = new StorageError({ message: "storage failed" })
    // @ts-expect-error — search results must expose branded host-domain ids, not raw storage rows
    const badSearchResult: SearchResult = [storageResult]

    void error
    void result
    void badSessionError
    void badSearchResult
    expect(true).toBe(true)
  })

  test("public extension api does not expose runtime engine tags or server routers", () => {
    // @ts-expect-error — machine execution is a runtime seam, not authoring surface
    type _BadMachineExecute = PublicExtensionApi.MachineExecute
    // @ts-expect-error — machine write surface is runtime-internal
    type _BadActorRouter = PublicExtensionApi.ActorRouter
    // @ts-expect-error — tool runner is runtime plumbing, not extension authoring api
    type _BadToolRunner = PublicExtensionApi.ToolRunner
    // @ts-expect-error — interaction pending reader is a storage seam, not authoring api
    type _BadInteractionPendingReader = PublicExtensionApi.InteractionPendingReader
    // @ts-expect-error — event publisher is an app/domain service, not extension api
    type _BadEventPublisher = PublicExtensionApi.EventPublisher

    expect(true).toBe(true)
  })

  test("reactions.systemPrompt MUST return Effect — async handler rejected", () => {
    defineExtension({
      id: "bad-prompt-reaction",
      reactions: {
        // @ts-expect-error — async handler must not be assignable to Effect-returning systemPrompt
        systemPrompt: async (input) => `${input.basePrompt}x`,
      },
    })
    expect(true).toBe(true)
  })

  test("extension reactions and lifecycle hooks reject Promise handlers", () => {
    defineExtension({
      id: "purity-reaction",
      reactions: {
        turnAfter: {
          failureMode: "isolate",
          // @ts-expect-error — async handler must not be assignable to Effect-returning extension reaction
          handler: async () => undefined,
        },
      },
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
      tools: [
        tool({
          id: "noop",
          description: "noop",
          params: Schema.Struct({}),
          execute: () => Effect.succeed("ok"),
        }),
      ],
      reactions: {
        systemPrompt: (input) => Effect.succeed(`${input.basePrompt}suffix`),
        turnAfter: {
          failureMode: "continue",
          handler: () => Effect.void,
        },
      },
      resources: [
        resource(
          defineResource({
            scope: "process",
            layer: Layer.empty,
            start: Effect.void,
            stop: Effect.void,
            schedule: [
              {
                id: "j",
                cron: "0 0 * * *",
                target: { agent: "cowork" as never, prompt: "hi" },
              },
            ],
          }),
        ),
      ],
    })

    expect(ext.manifest.id as string).toBe("purity-positive")
  })
})

type AssertReadOnlyExtendsTag = ReadOnly<ReadOnlyShape> extends ReadOnlyTag ? true : false
const readOnlyExtendsTag: AssertReadOnlyExtendsTag = true
void readOnlyExtendsTag
