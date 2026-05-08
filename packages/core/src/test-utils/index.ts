import { Clock, Context, DateTime, Effect, Layer, Ref, Stream } from "effect"
import type { ExtensionSetupContext } from "../domain/extension.js"
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
import { EventStore, EventEnvelope, matchesEventFilter } from "../domain/event.js"
import type { EventStoreService } from "../domain/event.js"

// Re-export effect-bun-test
export { it, describe, expect } from "effect-bun-test"
export { testExtensionHostContext } from "./extension-host-context.js"
export {
  capabilityAccessNeedsLayer,
  provideCapabilityAccessNeeds,
} from "../domain/capability-access.js"

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
    let nextId = 0

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
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        yield* service.append(event)
        yield* recorder.record({
          service: "EventStore",
          method: "publish",
          args: event,
        })
      }),
      subscribe: ({ sessionId, branchId, after }) =>
        Stream.fromIterable(
          events.filter(
            (env) => matchesEventFilter(env, sessionId, branchId) && env.id > (after ?? 0),
          ),
        ),
      removeSession: () => Effect.void,
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
export const testSetupCtx = (
  overrides?: Partial<Pick<ExtensionSetupContext, "cwd" | "source" | "home">>,
): ExtensionSetupContext => ({
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
  testToolContext,
  type ToolTestLayerConfig,
} from "./extension-harness.js"
