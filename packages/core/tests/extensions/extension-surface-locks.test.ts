/**
 * Extension surface regression locks (compile-time).
 *
 * One intentional lock pack for the public extension authoring surface:
 * 1. capability factory shapes stay honest
 * 2. Promise handlers stay out of Effect-returning seams
 * 3. read-only branding remains available for request/reaction service seams
 *
 * Runtime composition has separate behavior tests; this file only locks the
 * public extension authoring surface.
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
>()("@gent/core/tests/extensions/extension-surface-locks.test/WriteCapableService") {}

type WriteCapableReadExecuteAssignable = (() => Effect.Effect<
  string,
  never,
  WriteCapableService
>) extends ReadRequestInput<unknown, string, never>["execute"]
  ? true
  : false

interface ReadOnlyShape {
  readonly read: () => Effect.Effect<string>
}

class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnly<ReadOnlyShape>>()(
  "@gent/core/tests/extensions/extension-surface-locks.test/ReadOnlyService",
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
      output: Schema.String,
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
      output: StringOutput,
      // @ts-expect-error — `surface` is an action-only field
      surface: "slash",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput

    void badInput
    expect(true).toBe(true)
  })

  test("tool({...}) defaults to minimal ctx unless wide ctx is explicit", () => {
    tool({
      id: "minimal-tool-context",
      description: "ok",
      params: NoInput,
      output: StringOutput,
      execute: (_params, ctx) => {
        void ctx.sessionId
        void ctx.branchId
        void ctx.toolCallId
        // @ts-expect-error — agent runner is wide host authority, not default tool ctx
        void ctx.agent
        // @ts-expect-error — session mutation is wide host authority, not default tool ctx
        void ctx.session
        return Effect.succeed("ok")
      },
    })

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
    const writeCapableIsRejected: WriteCapableReadExecuteAssignable = false
    void writeCapableIsRejected
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
  test("tool.execute MUST return Effect — Promise handler rejected", () => {
    const promiseString = Effect.runPromise(Effect.succeed("result"))
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

  test("session.queueFollowUp is exposed for slot handlers and extension authors", () => {
    defineExtension({
      id: "queue-follow-up-compile-lock",
      reactions: {
        turnAfter: {
          failureMode: "continue",
          handler: (_input, ctx) => ctx.session.queueFollowUp({ content: "x" }),
        },
      },
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
    // @ts-expect-error — generic capability contribution is internal; authors use concrete leaf factories
    type _BadCapabilityContribution = PublicExtensionApi.CapabilityContribution
    // @ts-expect-error — generic capability contribution is internal; authors use concrete leaf factories
    type _BadAnyCapabilityContribution = PublicExtensionApi.AnyCapabilityContribution
    // @ts-expect-error — audience flags are internal lowering details, not public authoring API
    type _BadAudience = PublicExtensionApi.Audience
    // @ts-expect-error — request/tool factory inputs own their intent shape
    type _BadIntent = PublicExtensionApi.Intent
    // @ts-expect-error — model tool metadata is internal lowering detail
    type _BadModelAudienceFields = PublicExtensionApi.ModelAudienceFields
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadToolMetadataTag = typeof PublicExtensionApi.GentToolMetadataTag
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadGetToolMetadata = typeof PublicExtensionApi.getToolMetadata
    // @ts-expect-error — raw tool metadata is internal lowering detail
    type _BadIsToolCapability = typeof PublicExtensionApi.isToolCapability
    // @ts-expect-error — direct tool-effect extraction is a test helper, not authoring API
    type _BadGetToolEffect = typeof PublicExtensionApi.getToolEffect
    // @ts-expect-error — package shape validation is host loader plumbing, not authoring API
    type _BadValidatePackageShape = typeof PublicExtensionApi.validatePackageShape
    // @ts-expect-error — request refs are read via ref(...); the symbol stays private
    type _BadCapabilityRefSymbol = typeof PublicExtensionApi.CAPABILITY_REF
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

    expect(true).toBe(true)
  })

  test("reactions.systemPrompt MUST return Effect — Promise handler rejected", () => {
    const promiseString = Effect.runPromise(Effect.succeed("prompt"))
    defineExtension({
      id: "bad-prompt-reaction",
      reactions: {
        // @ts-expect-error — Promise handler must not be assignable to Effect-returning systemPrompt
        systemPrompt: () => promiseString,
      },
    })
    expect(true).toBe(true)
  })

  test("extension reactions and lifecycle hooks reject Promise handlers", () => {
    const promiseVoid = Effect.runPromise(Effect.void)
    defineExtension({
      id: "purity-reaction",
      reactions: {
        turnAfter: {
          failureMode: "isolate",
          // @ts-expect-error — Promise handler must not be assignable to Effect-returning extension reaction
          handler: () => promiseVoid,
        },
      },
    })
    defineResource({
      scope: "process",
      layer: Layer.empty,
      // @ts-expect-error — Promise must not be assignable to Effect Resource.start
      start: promiseVoid,
    })
    defineResource({
      scope: "process",
      layer: Layer.empty,
      // @ts-expect-error — Promise must not be assignable to Effect Resource.stop
      stop: promiseVoid,
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
          output: Schema.String,
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
