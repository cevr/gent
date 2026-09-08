import {
  Predicate,
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Random,
  Ref,
  Schema,
  Stream,
} from "effect"
import { ExtensionHostProcessError, type ExtensionHostPlatform } from "../domain/extension.js"
import { ExtensionHost, makeCollectingExtensionHost } from "../domain/extension-host.js"
import type { ExtensionContributions } from "../domain/contribution.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { Branch, Session } from "../domain/message.js"
import type { StorageError } from "../domain/storage-error.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import {
  EventStore,
  EventEnvelope,
  EventId,
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
  readonly getCalls: Effect.Effect<ReadonlyArray<CallRecord>>
  readonly clear: Effect.Effect<void>
}

export class SequenceRecorder extends Context.Service<SequenceRecorder, SequenceRecorderService>()(
  "@gent/core/src/test-utils/SequenceRecorder",
) {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return SequenceRecorder.of({
        record: (call) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(ref, (calls) => [...calls, { ...call, timestamp }])
          }),
        getCalls: Ref.get(ref),
        clear: Ref.set(ref, []),
      })
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
        if (!Predicate.isUndefined(existing)) return existing
        const ps = yield* PubSub.unbounded<EventEnvelope>()
        sessions.set(sessionId, ps)
        return ps
      })

    const service: EventStoreService = {
      append: Effect.fn("RecordingEventStore.append")(function* (event) {
        nextId += 1
        const createdAt = yield* Clock.currentTimeMillis
        const envelope = EventEnvelope.make({
          id: EventId.make(nextId),
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
          if (Predicate.isUndefined(sessionId)) return
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
          if (!Predicate.isUndefined(ps)) {
            sessions.delete(sessionId)
            yield* PubSub.shutdown(ps)
          }
        }),
    }

    return Layer.succeed(EventStore, service)
  }),
)

// Sequence Assertions

const CallMatch = Schema.Record(Schema.String, Schema.Unknown)
type CallMatch = typeof CallMatch.Type
const encodeCallMatch = Schema.encodeSync(Schema.fromJsonString(CallMatch))

const callMatches = (
  call: CallRecord,
  expected: { service: string; method: string; match?: CallMatch },
) => {
  if (call.service !== expected.service || call.method !== expected.method) return false
  if (Predicate.isUndefined(expected.match)) return true
  if (!Schema.is(CallMatch)(call.args)) return false
  const args = call.args
  return Object.entries(expected.match).every(([key, value]) => args[key] === value)
}

export const assertSequence = (
  actual: ReadonlyArray<CallRecord>,
  expected: ReadonlyArray<{
    service: string
    method: string
    match?: CallMatch
  }>,
) => {
  let actualIdx = 0

  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const call = actual[actualIdx]
      if (!Predicate.isUndefined(call) && callMatches(call, exp)) {
        found = true
        actualIdx++
        break
      }
      actualIdx++
    }

    if (!found) {
      const matchDescription = Option.fromUndefinedOr(exp.match).pipe(
        Option.match({ onNone: () => "", onSome: (match) => ` with ${encodeCallMatch(match)}` }),
      )
      return Effect.runSync(
        Effect.die(
          new Error(`Expected call not found: ${exp.service}.${exp.method}${matchDescription}`),
        ),
      )
    }
  }
}

// ── Test Extension Host ──

/** Facts the test extension host reports to `setup` Effects. */
export interface TestExtensionHostFacts {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}

export const testHostFacts = (
  overrides?: Partial<Pick<TestExtensionHostFacts, "cwd" | "source" | "home">>,
): TestExtensionHostFacts => ({
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
    randomId: Random.nextInt.pipe(Effect.map((value) => `test-${value}`)),
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

/**
 * Run a `GentExtension.setup` Effect against a collecting test host and
 * return the sealed contributions, mirroring the production loader.
 */
export const collectTestContributions = <E, R>(
  setup: Effect.Effect<void, E, R>,
  overrides?: Parameters<typeof testHostFacts>[0],
): Effect.Effect<ExtensionContributions, E, Exclude<R, ExtensionHost>> =>
  Effect.gen(function* () {
    const collector = makeCollectingExtensionHost(testHostFacts(overrides))
    yield* setup.pipe(Effect.provideService(ExtensionHost, collector.service))
    return yield* collector.seal
  })

// Mock Helpers

export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: never
}): Effect.Effect<void, StorageError, SessionStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId: BranchId | string
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: BranchId | string
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage> {
  return Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const sessionId = SessionId.make(input.sessionId)
    const branchId = Option.fromUndefinedOr(input.branchId).pipe(
      Option.map((id) => BranchId.make(id)),
    )
    const now = yield* DateTime.nowAsDate

    const session = yield* sessionStorage.getSession(sessionId)
    if (Predicate.isUndefined(session)) {
      yield* sessionStorage.createSession(
        new Session({
          id: sessionId,
          createdAt: now,
          updatedAt: now,
        }),
      )
    }

    if (Option.isSome(branchId)) {
      const branchStorage = yield* BranchStorage
      const branch = yield* branchStorage.getBranch(branchId.value)
      if (Predicate.isUndefined(branch)) {
        yield* branchStorage.createBranch(
          new Branch({
            id: branchId.value,
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
  provideTinyContextWindow,
  trackingApprovalService,
} from "./e2e-layer.js"

// Extension tool test helpers
export {
  createToolTestLayer,
  runToolWithCtx,
  testToolContext,
  type ToolTestLayerConfig,
} from "./extension-harness.js"
