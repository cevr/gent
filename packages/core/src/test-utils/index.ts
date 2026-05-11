import { Clock, Context, DateTime, Effect, Layer, PubSub, Ref, Stream } from "effect"
import {
  ExtensionHostProcessError,
  type ExtensionHostPlatform,
  type ExtensionSetupContext,
} from "../domain/extension.js"
import { BranchId, SessionId, type ToolCallId } from "../domain/ids.js"
import { Branch, Session } from "../domain/message.js"
import type { StorageError } from "../domain/storage-error.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import {
  finishPart,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "./language-model.js"
import {
  EventStore,
  EventEnvelope,
  getEventSessionId,
  matchesEventFilter,
} from "../domain/event.js"
import type { EventStoreService } from "../domain/event.js"

// Re-export effect-bun-test
export { it, describe, expect } from "effect-bun-test"
export { testExtensionHostContext } from "./extension-host-context.js"

// Call Record

export interface CallRecord {
  service: string
  method: string
  args?: unknown
  result?: unknown
  timestamp: number
}

// Sequence Recorder Service

export interface SequenceRecorderService {
  readonly record: (call: Omit<CallRecord, "timestamp">) => Effect.Effect<void>
  readonly getCalls: () => Effect.Effect<ReadonlyArray<CallRecord>>
  readonly clear: () => Effect.Effect<void>
}

export class SequenceRecorder extends Context.Service<SequenceRecorder, SequenceRecorderService>()(
  "@gent/core/src/test-utils/SequenceRecorder",
) {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return {
        record: (call) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(ref, (calls) => [...calls, { ...call, timestamp }])
          }),
        getCalls: () => Ref.get(ref),
        clear: () => Ref.set(ref, []),
      }
    }),
  )
}

// Recording EventStore

export const RecordingEventStore: Layer.Layer<EventStore, never, SequenceRecorder> = Layer.unwrap(
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: EventEnvelope[] = []
    const sessions = new Map<SessionId, PubSub.PubSub<EventEnvelope>>()
    let nextId = 0
    const getOrCreateSessionPubSub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const existing = sessions.get(sessionId)
        if (existing !== undefined) return existing
        const ps = yield* PubSub.unbounded<EventEnvelope>()
        sessions.set(sessionId, ps)
        return ps
      })

    const service: EventStoreService = {
      append: Effect.fn("RecordingEventStore.append")(function* (event) {
        nextId += 1
        const createdAt = yield* Clock.currentTimeMillis
        const envelope = EventEnvelope.make({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
          id: nextId as EventEnvelope["id"],
          event,
          createdAt,
        })
        events.push(envelope)
        yield* recorder.record({
          service: "EventStore",
          method: "append",
          args: event,
        })
        return envelope
      }),
      broadcast: () => Effect.void,
      deliver: (envelope) =>
        Effect.gen(function* () {
          const sessionId = getEventSessionId(envelope.event)
          if (sessionId === undefined) return
          const ps = yield* getOrCreateSessionPubSub(sessionId)
          yield* PubSub.publish(ps, envelope)
        }),
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        const envelope = yield* service.append(event)
        yield* service.deliver(envelope)
        yield* recorder.record({
          service: "EventStore",
          method: "publish",
          args: event,
        })
      }),
      subscribe: ({ sessionId, branchId, after }) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const afterId = after ?? 0
              const ps = yield* getOrCreateSessionPubSub(sessionId)
              const subscription = yield* PubSub.subscribe(ps)
              const latestId = nextId
              const buffered = events.filter(
                (env) => matchesEventFilter(env, sessionId, branchId) && env.id > afterId,
              )
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (env) => matchesEventFilter(env, sessionId, branchId) && env.id > latestId,
                ),
              )
              return Stream.concat(Stream.fromIterable(buffered), live)
            }),
          ),
        ),
      removeSession: (sessionId) =>
        Effect.gen(function* () {
          const ps = sessions.get(sessionId)
          if (ps !== undefined) {
            sessions.delete(sessionId)
            yield* PubSub.shutdown(ps)
          }
        }),
    }

    return Layer.succeed(EventStore, service)
  }),
)

// Sequence Assertions

export const assertSequence = (
  actual: ReadonlyArray<CallRecord>,
  expected: ReadonlyArray<{
    service: string
    method: string
    match?: Record<string, unknown>
  }>,
) => {
  let actualIdx = 0

  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const call = actual[actualIdx]
      if (call !== undefined && call.service === exp.service && call.method === exp.method) {
        if (exp.match !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
          const argsObj = call.args as Record<string, unknown> | undefined
          if (argsObj !== undefined) {
            const matches = Object.entries(exp.match).every(([k, v]) => argsObj[k] === v)
            if (matches) {
              found = true
              actualIdx++
              break
            }
          }
        } else {
          found = true
          actualIdx++
          break
        }
      }
      actualIdx++
    }

    if (!found) {
      throw new Error(
        `Expected call not found: ${exp.service}.${exp.method}${
          exp.match !== undefined ? ` with ${JSON.stringify(exp.match)}` : ""
        }`,
      )
    }
  }
}

// ── Test Extension Setup Context ──

/** Pre-built ExtensionSetupContext for tests. */
export type TestExtensionSetupContext = Omit<ExtensionSetupContext, "host"> & {
  readonly host: ExtensionHostPlatform
}

export const testSetupCtx = (
  overrides?: Partial<Pick<ExtensionSetupContext, "cwd" | "source" | "home">>,
): TestExtensionSetupContext => ({
  cwd: overrides?.cwd ?? "/tmp",
  source: overrides?.source ?? "test",
  home: overrides?.home ?? "/tmp",
  host: {
    osInfo: {
      platform: "darwin",
      arch: "arm64",
      release: "test",
      hostname: "test-host",
      type: "Darwin",
    },
    execPath: "/usr/bin/node",
    homeDirectory: overrides?.home ?? "/tmp",
    parentEnv: {},
    pathListSeparator: ":",
    commandCandidates: (command) => [command],
    isPortFree: () => Effect.succeed(true),
    isPidAlive: () => Effect.succeed(true),
    signalPid: () => Effect.void,
    runProcess: (command) =>
      Effect.fail(
        new ExtensionHostProcessError({
          command,
          message: "test host runProcess unavailable",
        }),
      ),
  },
})

// Mock Helpers

export const mockTextResponse = (text: string): LanguageModelStreamPart[] => [
  textDeltaPart(text),
  finishPart({ finishReason: "stop" }),
]

export const mockToolCallResponse = (
  toolCallId: ToolCallId,
  toolName: string,
  input: unknown,
): LanguageModelStreamPart[] => [
  toolCallPart(toolName, input, { toolCallId }),
  finishPart({ finishReason: "tool-calls" }),
]

export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: undefined
}): Effect.Effect<void, StorageError, SessionStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId: BranchId | string
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: BranchId | string | undefined
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage> {
  return Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const sessionId = SessionId.make(input.sessionId)
    const branchId = input.branchId === undefined ? undefined : BranchId.make(input.branchId)
    const now = yield* DateTime.nowAsDate

    const session = yield* sessionStorage.getSession(sessionId)
    if (session === undefined) {
      yield* sessionStorage.createSession(
        new Session({
          id: sessionId,
          createdAt: now,
          updatedAt: now,
        }),
      )
    }

    if (branchId !== undefined) {
      const branchStorage = yield* BranchStorage
      const branch = yield* branchStorage.getBranch(branchId)
      if (branch === undefined) {
        yield* branchStorage.createBranch(
          new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          }),
        )
      }
    }
  })
}

// E2E test layer
export {
  createE2ELayer,
  type E2ELayerConfig,
  withTinyContextWindow,
  trackingApprovalService,
} from "./e2e-layer.js"

// Extension tool test helpers
export {
  createToolTestLayer,
  runToolWithCtx,
  testToolContext,
  type ToolTestLayerConfig,
} from "./extension-harness.js"
