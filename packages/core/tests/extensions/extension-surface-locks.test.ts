/**
 * Extension surface regression locks (compile-time).
 *
 * One intentional lock pack for the public extension authoring surface:
 * 1. capability factory shapes stay honest
 * 2. Promise handlers stay out of Effect-returning seams
 * 3. ExtensionContext stays the single host-authority import
 *
 * Runtime composition has separate behavior tests; this file only locks the
 * public extension authoring surface.
 */

import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import type * as PublicExtensionApi from "@gent/core/extensions/api"
import {
  CapabilityError,
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionId,
  ExtensionSetupContext,
  makeRunSpec,
  request,
  tool,
  ToolCallId,
  type RequestInput,
  type ToolInput,
} from "@gent/core/extensions/api"

class WriteCapableService extends Context.Service<
  WriteCapableService,
  { readonly write: () => Effect.Effect<void> }
>()("@gent/core/tests/extensions/extension-surface-locks.test/WriteCapableService") {}

interface ReadOnlyShape {
  readonly read: () => Effect.Effect<string>
}

class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnlyShape>()(
  "@gent/core/tests/extensions/extension-surface-locks.test/ReadOnlyService",
) {}

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
          void ctx.Agent
          void ctx.Session
          return "ok"
        }),
    })

    expect(true).toBe(true)
  })

  test("request({...}) — happy path compiles with ordinary Effect services", () => {
    const ok = request({
      id: "ok-read",
      extensionId: ExtensionId.make("test-ext"),
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

  test("request({...}) may yield ExtensionContext", () => {
    const ok = request({
      id: "read-context",
      extensionId: ExtensionId.make("test-ext"),
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
      extensionId: ExtensionId.make("test-ext"),
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

  test("request handlers receive params only", () => {
    const bad: RequestInput<{}, string> = {
      id: "write-core-context",
      extensionId: ExtensionId.make("surface-locks"),
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
      extensionId: ExtensionId.make("surface-locks"),
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          yield* ctx.Session.queueFollowUp({ sourceId: "lock", content: "x" })
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
      extensionId: ExtensionId.make("test-ext"),
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
    const promiseString = Bun.file("/dev/null").text()
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
      needs: [{ tag: "todo", access: "write" }] as const,
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("request handlers receive decoded input only", () => {
    const bad: RequestInput<{}, void, never> = {
      id: "default-request-context",
      extensionId: ExtensionId.make("default-request-context-ext"),
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
      requests: [
        request({
          id: "queue-follow-up",
          extensionId: ExtensionId.make("queue-follow-up-compile-lock"),
          slash: { name: "Queue Follow Up", description: "ok" },
          input: Schema.Struct({}),
          output: Schema.Void,
          execute: () =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              yield* ctx.Session.queueFollowUp({ sourceId: "lock", content: "x" })
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
      ],
      reactions: {
        turnAfter: {
          handler: (_input: PublicExtensionApi.TurnAfterInput) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              void ctx.Session.listMessages
              void ctx.Session.queueFollowUp
            }),
        },
      },
    })

    expect(true).toBe(true)
  })

  test("removed reaction slots are not part of the public reactions bag", () => {
    type Reactions = NonNullable<Parameters<typeof defineExtension>[0]["reactions"]>
    // @ts-expect-error — messageInput reaction was removed; mutations belong in tools/requests
    type _MessageInput = Reactions["messageInput"]
    // @ts-expect-error — contextMessages reaction was removed; turnProjection composes prompt context
    type _ContextMessages = Reactions["contextMessages"]
    // @ts-expect-error — permissionCheck reaction was removed; permission policy is host-owned
    type _PermissionCheck = Reactions["permissionCheck"]
    // @ts-expect-error — toolExecute reaction was removed; tools own their effect
    type _ToolExecute = Reactions["toolExecute"]
    // @ts-expect-error — turnBefore reaction was removed; turnProjection runs at turn start
    type _TurnBefore = Reactions["turnBefore"]
    // @ts-expect-error — messageOutput reaction was removed; assistant parts persist directly
    type _MessageOutput = Reactions["messageOutput"]
    expect(true).toBe(true)
  })

  test("reaction handler field shape is locked to handler-only", () => {
    type TurnAfterSlot = NonNullable<
      NonNullable<Parameters<typeof defineExtension>[0]["reactions"]>["turnAfter"]
    >
    // @ts-expect-error — failureMode field was removed; runtime always isolates reaction failures
    type _FailureMode = TurnAfterSlot["failureMode"]
    expect(true).toBe(true)
  })

  test("ExtensionContext.Files exposes listFiles only", () => {
    type FilesService = PublicExtensionApi.ExtensionContextService["Files"]
    // @ts-expect-error — searchFiles was removed; fuzzy search lives in TUI utils, not ExtensionFiles
    type _SearchFiles = FilesService["searchFiles"]
    // @ts-expect-error — trackSelection was removed; frecency learning lives in TUI utils, not ExtensionFiles
    type _TrackSelection = FilesService["trackSelection"]
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

  test("reaction handlers receive event input only", () => {
    defineExtension({
      id: "reaction-handler-params-lock",
      reactions: {
        turnAfter: {
          // @ts-expect-error — host authority comes from ExtensionContext, not a ctx parameter
          handler: (_input: PublicExtensionApi.TurnAfterInput, _ctx: unknown) => Effect.void,
        },
      },
    })
    expect(true).toBe(true)
  })

  test("private host and storage shapes stay out of the public API", () => {
    // @ts-expect-error — raw host context is runtime plumbing; authors use typed handlers
    type _BadHostContext = PublicExtensionApi.ExtensionHostContext
    // @ts-expect-error — projection runtime ctx is host plumbing; reactions yield ExtensionContext
    type _BadProjectionTurnContext = PublicExtensionApi.ProjectionTurnContext
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
    // @ts-expect-error — individual authority facades are collapsed into ExtensionContext
    type _BadExtensionState = typeof PublicExtensionApi.ExtensionState
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
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadReadOnlyBrand = typeof PublicExtensionApi.ReadOnlyBrand
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadWithReadOnly = typeof PublicExtensionApi.withReadOnly
    // @ts-expect-error — read/write authority is host facade behavior, not author branding ceremony
    type _BadReadOnly = PublicExtensionApi.ReadOnly<ReadOnlyShape>
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
    // @ts-expect-error — ToolRunner is runtime engine plumbing; external drivers receive ctx.runTool
    type _BadToolRunner = typeof PublicExtensionApi.ToolRunner
    // @ts-expect-error — raw event publishing can forge core runtime events
    type _BadExtensionEventSink = typeof PublicExtensionApi.ExtensionEventSink
    // @ts-expect-error — todo lifecycle events are private; extensions publish state pulses
    type _BadTodoCreated = typeof PublicExtensionApi.TodoCreated
    // @ts-expect-error — todo schemas belong to @gent/todo, not core author API
    type _BadTodo = typeof PublicExtensionApi.Todo
    // @ts-expect-error — todo ids belong to @gent/todo, not core author API
    type _BadTodoId = typeof PublicExtensionApi.TodoId
    // @ts-expect-error — process spawning is host/internal plumbing; authors use ExtensionContext.Process
    type _BadRunProcess = typeof PublicExtensionApi.runProcess
    // @ts-expect-error — process errors are paired with the non-public process runner
    type _BadProcessError = typeof PublicExtensionApi.ProcessError
    // @ts-expect-error — host platform service is not public extension author API
    type _BadGentPlatform = typeof PublicExtensionApi.GentPlatform
    // @ts-expect-error — host-context errors are runtime internals, not authoring API
    type _BadExtensionHostError = typeof PublicExtensionApi.ExtensionHostError
    // @ts-expect-error — raw host search result shape is runtime internals, not authoring API
    type _BadExtensionHostSearchResult = typeof PublicExtensionApi.ExtensionHostSearchResult
    // @ts-expect-error — raw runtime events can forge product state
    type _BadAgentEvent = typeof PublicExtensionApi.AgentEvent
    // @ts-expect-error — transport event envelopes are SDK/TUI plumbing, not authoring API
    type _BadEventEnvelope = PublicExtensionApi.EventEnvelope
    // @ts-expect-error — interaction wire state is client/runtime plumbing
    type _BadActiveInteraction = PublicExtensionApi.ActiveInteraction
    // @ts-expect-error — raw host platform includes process authority; authors use setup facts or ExtensionContext.Process
    type _BadExtensionHostPlatform = PublicExtensionApi.ExtensionHostPlatform
    // @ts-expect-error — raw process errors are mapped through ExtensionServiceError in public facades
    type _BadExtensionHostProcessError = typeof PublicExtensionApi.ExtensionHostProcessError
    // @ts-expect-error — schema helper is an internal core migration primitive
    type _BadTaggedEnumClass = typeof PublicExtensionApi.TaggedEnumClass
    // @ts-expect-error — host file index Tag is private; extensions reach files through ExtensionContext.Files
    type _BadFileIndex = typeof PublicExtensionApi.FileIndex
    // @ts-expect-error — host file lock Tag is private; extensions reach file locks through ExtensionContext.FileLock
    type _BadFileLockService = typeof PublicExtensionApi.FileLockService
    // @ts-expect-error — extension state publisher is private; extensions publish through ExtensionContext.State
    type _BadExtensionStatePublisher = typeof PublicExtensionApi.ExtensionStatePublisher
    // @ts-expect-error — capability access enforcement is runtime lowering, not author API
    type _BadRequireCapabilityWrite = typeof PublicExtensionApi.requireCapabilityWrite
    type _AllowedOutputBuffer = typeof PublicExtensionApi.OutputBuffer
    type _AllowedArtifactId = typeof PublicExtensionApi.ArtifactId

    expect(true).toBe(true)
  })

  test("read request handlers do not receive host facts by parameter", () => {
    const bad: RequestInput<{}, string> = {
      id: "facts-only-read",
      extensionId: ExtensionId.make("surface-locks"),
      input: Schema.Struct({}),
      output: Schema.String,
      // @ts-expect-error — request handlers receive decoded params only; facts come from ExtensionContext/setup context
      execute: (_input, _ctx) => Effect.succeed("ok"),
    }
    void bad
    expect(true).toBe(true)
  })

  test("public setup context exposes host facts but not process authority", () => {
    const setup = Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      const platform = ctx.host.osInfo.platform
      const candidates = ctx.host.commandCandidates("git")
      // @ts-expect-error — public setup sees host facts, not parent process env
      void ctx.host.parentEnv
      // @ts-expect-error — public setup cannot signal host processes
      ctx.host.signalPid(1, "SIGTERM")
      // @ts-expect-error — public setup cannot spawn host processes
      ctx.host.runProcess("git", ["status"])
      return `${platform}:${candidates.length}`
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

  test("process authority is imported as ExtensionContext.Process", () => {
    tool({
      id: "process-authority-tool",
      description: "process",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          yield* ctx.Process.run("git", ["status"])
          return "ok"
        }),
    })
    expect(true).toBe(true)
  })

  test("reactions.systemPrompt MUST return Effect — Promise handler rejected", () => {
    const promiseString = Bun.file("/dev/null").text()
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
    const promiseVoid = Bun.sleep(0)
    defineExtension({
      id: "purity-reaction",
      reactions: {
        turnAfter: {
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
          handler: () => Effect.void,
        },
      },
      resources: [
        defineResource({
          scope: "process",
          layer: Layer.succeed(ReadOnlyService, {
            read: () => Effect.succeed(""),
          } satisfies ReadOnlyShape),
          start: Effect.void,
          stop: Effect.void,
        }),
      ],
      scheduledJobs: [
        {
          id: "j",
          cron: "0 0 * * *",
          target: { agent: "cowork" as never, prompt: "hi" },
        },
      ],
    })

    expect(ext.manifest.id as string).toBe("purity-positive")
  })
})
