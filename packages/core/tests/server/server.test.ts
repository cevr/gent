import { test } from "bun:test"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import {
  buildExtensionHealthSnapshot,
  getSessionSnapshot,
  SessionMutationsLive,
  buildBranchTree,
  getBranchTree,
} from "../../src/server/server"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "../../src/server/rpc"
import {
  BranchId,
  ExtensionId,
  MessageId,
  ProcessGenerationId,
  SessionId,
} from "../../src/domain/ids"
import { describe, expect, it } from "effect-bun-test"
import { StorageError } from "../../src/domain/errors.js"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
  waitFor,
} from "../../src/test-utils/language-model"
import { createE2ELayer, createRpcClient, testSqliteStorage } from "../../src/test-utils/harness"
import {
  messagePartsText,
  Branch,
  dateFromMillis,
  Message,
  Session,
  type SteerCommand,
} from "../../src/domain/message"
import { e2ePreset } from "../helpers/test-preset"
import {
  BranchStorage,
  MessageStorage,
  SessionStorage,
  SqliteStorage,
} from "../../src/storage/storage"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { ConfigService, UserConfig } from "../../src/runtime/config"
import {
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
  type SessionProfile,
} from "../../src/runtime/extension-host"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { makeRequestDeduper, SessionRuntimeError } from "../../src/runtime/session"
import {
  collectSessionEvents,
  createActiveSessionFixture,
  failingDeleteSessionMutationsLayerWithMachineProbe,
  failingSessionMutationsLayer,
  FIXED_NOW,
  interleavedSessionMutationsLayer,
  makeClient,
  makeRpcHandlersClient,
  racySessionMutationsLayer,
  sessionMutationsLayer,
  sessionMutationsLayerWithMachineProbe,
  sessionRuntimeLayer,
} from "./session-mutations"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SessionMutations } from "../../src/domain/extension"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  ModelId,
} from "../../src/domain/agent"
import { type EventEnvelope, EventStore, SessionStarted } from "../../src/domain/event"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql"
import { ModelResolver } from "../../src/runtime/provider"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent-loop"

// ── extension health ────────────────────────────────────────────────────────

describe("buildExtensionHealthSnapshot", () => {
  test("reports one typed issue row per failed extension", () => {
    const snapshot = buildExtensionHealthSnapshot([
      {
        manifest: { id: ExtensionId.make("@gent/memory") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "failed",
        phase: "startup",
        error: "startup boom",
      },
      {
        manifest: { id: ExtensionId.make("@gent/plan") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "failed",
        phase: "setup",
        error: "setup boom",
      },
    ])

    expect(snapshot._tag).toBe("Degraded")
    if (snapshot._tag !== "Degraded") return

    expect(snapshot.healthyExtensions).toEqual([])
    expect(snapshot.degradedExtensions).toEqual([
      {
        manifest: { id: "@gent/memory" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "Degraded",
        issues: [
          {
            _tag: "ActivationFailed",
            phase: "startup",
            error: "startup boom",
          },
        ],
      },
      {
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "Degraded",
        issues: [
          {
            _tag: "ActivationFailed",
            phase: "setup",
            error: "setup boom",
          },
        ],
      },
    ])
  })

  test("returns a healthy snapshot when every extension has no issues", () => {
    const snapshot = buildExtensionHealthSnapshot([
      {
        manifest: { id: ExtensionId.make("@gent/memory") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "active",
      },
    ])

    expect(snapshot).toEqual({
      _tag: "Healthy",
      extensions: [
        {
          _tag: "Healthy",
          manifest: { id: ExtensionId.make("@gent/memory") },
          scope: "builtin",
          sourcePath: "builtin",
        },
      ],
    })
  })

  test("health issue constructors preserve typed failure categories", () => {
    expect(
      ExtensionHealthIssue.cases.ActivationFailed.make({
        phase: "startup",
        error: "startup boom",
      }),
    ).toEqual({
      _tag: "ActivationFailed",
      phase: "startup",
      error: "startup boom",
    })
  })

  test("degraded constructor requires non-empty issues", () => {
    expect(
      ExtensionHealth.cases.Degraded.make({
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        issues: [
          ExtensionHealthIssue.cases.ActivationFailed.make({
            phase: "startup",
            error: "launchd boom",
          }),
        ],
      }),
    ).toEqual({
      _tag: "Degraded",
      manifest: { id: "@gent/plan" },
      scope: "builtin",
      sourcePath: "builtin",
      issues: [
        {
          _tag: "ActivationFailed",
          phase: "startup",
          error: "launchd boom",
        },
      ],
    })
  })

  test("transport uses tagged extension health states and issues", () => {
    const wire = {
      _tag: "Degraded",
      healthyExtensions: [],
      degradedExtensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          _tag: "Degraded",
          issues: [
            {
              _tag: "ActivationFailed",
              phase: "startup",
              error: "launchd boom",
            },
          ],
        },
      ],
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(wire)
    expect(decoded._tag).toBe("Degraded")
    if (decoded._tag !== "Degraded") return
    expect(decoded.degradedExtensions[0]?.issues[0]).toEqual({
      _tag: "ActivationFailed",
      phase: "startup",
      error: "launchd boom",
    })

    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)
    expect(encoded).toMatchObject({
      _tag: "Degraded",
      degradedExtensions: [
        {
          _tag: "Degraded",
          issues: [
            {
              _tag: "ActivationFailed",
              phase: "startup",
              error: "launchd boom",
            },
          ],
        },
      ],
    })
  })

  test("transport rejects healthy snapshots containing degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Healthy",
        extensions: [
          {
            manifest: { id: ExtensionId.make("@gent/memory") },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [{ _tag: "ActivationFailed", phase: "startup", error: "startup boom" }],
          },
        ],
      }),
    ).toThrow()
  })

  test("transport rejects degraded snapshots without degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [],
      }),
    ).toThrow()
  })

  test("transport rejects degraded rows without issues", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: ExtensionId.make("@gent/memory") },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [],
          },
        ],
      }),
    ).toThrow()
  })
})

// ── branch tree ─────────────────────────────────────────────────────────────

/**
 * Regression suite for the `getBranchTree` pure helper.
 *
 * The helper replaces the old `SessionQueries.getBranchTree` plumbed
 * method (W35-C4). Pin its public contract — composition over
 * `BranchStorage.listBranches` + `BranchStorage.countMessagesByBranches`
 * + pure `buildBranchTree`, and propagation of a delegated failure as
 * `StorageError` — so future refactors cannot silently re-introduce a
 * service method or skip the typed-error surface.
 */

const SESSION_ID = SessionId.make("test-session")
const ROOT_ID = BranchId.make("branch-root")
const CHILD_ID = BranchId.make("branch-child")
const ORPHAN_ID = BranchId.make("branch-orphan")

const makeBranch = (id: BranchId, createdMs: number, parentBranchId?: BranchId) => {
  const base = {
    id,
    sessionId: SESSION_ID,
    createdAt: dateFromMillis(createdMs),
  }
  if (Predicate.isUndefined(parentBranchId)) return new Branch(base)
  return new Branch({ ...base, parentBranchId })
}

const die = (label: string) => (): Effect.Effect<never, StorageError, never> =>
  Effect.die(`${label} not wired in test`)

const branchStorageLayer = (
  branches: ReadonlyArray<Branch>,
  counts: ReadonlyMap<BranchId, number>,
) =>
  Layer.succeed(
    BranchStorage,
    BranchStorage.of({
      createBranch: die("createBranch"),
      getBranch: die("getBranch"),
      listBranches: () => Effect.succeed(branches),
      countMessagesByBranches: () => Effect.succeed(counts),
    }),
  )

describe("getBranchTree helper", () => {
  it.live("composes listBranches + countMessagesByBranches via buildBranchTree", () =>
    Effect.gen(function* () {
      const branches = [
        makeBranch(ROOT_ID, 0),
        makeBranch(CHILD_ID, 100, ROOT_ID),
        makeBranch(ORPHAN_ID, 50),
      ]
      const counts = new Map<BranchId, number>([
        [ROOT_ID, 3],
        [CHILD_ID, 7],
        [ORPHAN_ID, 1],
      ])
      const tree = yield* getBranchTree(SESSION_ID).pipe(
        Effect.provide(branchStorageLayer(branches, counts)),
      )
      // Assert exact equality against the pure builder. A regression
      // that drops listBranches' or countMessagesByBranches' values
      // (e.g. passing [] or an empty map) would fail this equality.
      expect(tree).toEqual(buildBranchTree(branches, counts))
      // Sanity check the shape so the equality target is non-trivial.
      expect(tree).toHaveLength(2)
      const root = tree.find((node) => node.branch.id === ROOT_ID)
      expect(root?.messageCount).toBe(3)
      expect(root?.children).toHaveLength(1)
      expect(root?.children[0]?.branch.id).toBe(CHILD_ID)
      expect(root?.children[0]?.messageCount).toBe(7)
    }),
  )

  it.live("propagates listBranches failures as StorageError", () =>
    Effect.gen(function* () {
      const failure = new StorageError({ message: "boom" })
      const layer = Layer.succeed(
        BranchStorage,
        BranchStorage.of({
          createBranch: die("createBranch"),
          getBranch: die("getBranch"),
          listBranches: () => Effect.fail(failure),
          countMessagesByBranches: () => Effect.succeed(new Map<BranchId, number>()),
        }),
      )
      const exit = yield* Effect.exit(getBranchTree(SESSION_ID).pipe(Effect.provide(layer)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(StorageError)(error.value)).toBe(true)
    }),
  )

  it.live("propagates countMessagesByBranches failures as StorageError", () =>
    Effect.gen(function* () {
      const failure = new StorageError({ message: "count boom" })
      const layer = Layer.succeed(
        BranchStorage,
        BranchStorage.of({
          createBranch: die("createBranch"),
          getBranch: die("getBranch"),
          listBranches: () => Effect.succeed([makeBranch(ROOT_ID, 0)]),
          countMessagesByBranches: () => Effect.fail(failure),
        }),
      )
      const exit = yield* Effect.exit(getBranchTree(SESSION_ID).pipe(Effect.provide(layer)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(StorageError)(error.value)).toBe(true)
    }),
  )
})

// ── session queries ─────────────────────────────────────────────────────────

const collectRuntime = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach((value) =>
        Ref.update(values, (current) => [...current, value]).pipe(
          Effect.andThen(Deferred.succeed(ready, void 0).pipe(Effect.ignore)),
        ),
      ),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return values
  })

const sessionQueriesActorFailureLayer = Layer.mergeAll(
  testSqliteStorage(() => Layer.empty, {}),
  GentPlatform.Test(),
  ConfigService.Test(),
  ExtensionRegistry.Test(),
  sessionRuntimeLayer({
    getState: () =>
      Effect.fail(new SessionRuntimeError({ message: "injected runtime state failure" })),
  }),
)

describe("session queries", () => {
  it.live(
    "getSessionSnapshot matches the persisted conversation and public watchRuntime settles on the same runtime state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "snapshot request"
          const assistantText = "snapshot reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntime(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "session snapshot assistant reply",
          )

          const observedStates = yield* waitFor(
            Ref.get(runtime),
            (current) => current.length >= 2 && current[current.length - 1]?._tag === "Idle",
            5_000,
            "watchRuntime settles on idle after the completed turn",
          )

          expect(observedStates.length).toBeGreaterThanOrEqual(2)
          expect(snapshot.runtime._tag).toBe("Idle")
          expect(observedStates[observedStates.length - 1]?._tag).toBe(snapshot.runtime._tag)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("getSessionSnapshot surfaces actor state failures instead of reporting idle", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("snapshot-actor-failure-session")
      const branchId = BranchId.make("snapshot-actor-failure-branch")
      const now = dateFromMillis(0)
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: sessionId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))

      const exit = yield* getSessionSnapshot({ sessionId, branchId }).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("InvalidStateError")
        expect(String(exit.cause)).toContain("Failed to read session runtime state")
      }
    }).pipe(Effect.timeout("4 seconds"), Effect.provide(sessionQueriesActorFailureLayer)),
  )

  it.live("createSession rejects a missing parent session through the public API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const result = yield* Effect.result(
          client.session.create({
            name: "Orphan",
            cwd: process.cwd(),
            parentSessionId: SessionId.make("nonexistent"),
          }),
        )

        expect(result._tag).toBe("Failure")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("createSession rejects parent branch without parent session through the public API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const result = yield* Effect.result(
          client.session.create({
            name: "Dangling branch parent",
            cwd: process.cwd(),
            parentBranchId: BranchId.make("dangling-parent-branch"),
          }),
        )

        expect(result._tag).toBe("Failure")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── session command persistence ─────────────────────────────────────────────

const absentModel = Option.getOrUndefined(Option.none<ModelId>())

describe("session command persistence", () => {
  it.live("message.send surfaces runtime failure and does not log message sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logMessages: string[] = []
        const captureLogger = Logger.make(({ message }) => {
          let rendered = String(message)
          if (Array.isArray(message)) rendered = message.map((entry) => String(entry)).join(" ")
          logMessages.push(rendered)
        })
        const { client, inWorkspace } = yield* makeRpcHandlersClient(
          {
            sendUserMessage: () =>
              Effect.fail(new SessionRuntimeError({ message: "runtime failed" })),
          },
          Logger.layer([captureLogger]),
        )

        const exit = yield* Effect.exit(
          inWorkspace(
            client["message.send"]({
              sessionId: SessionId.make("send-runtime-failure"),
              branchId: BranchId.make("send-runtime-failure-branch"),
              content: "fail loudly",
            }),
          ),
        )

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(SessionRuntimeError)
            expect(error.value.message).toBe("runtime failed")
          }
        }
        expect(logMessages).not.toContain("session.messageSent")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("rolls back session and branch creation when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage

      const exit = yield* Effect.exit(mutations.createSession({ cwd: "/nonexistent/rollback" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions).toHaveLength(0)
      expect(yield* branches.listBranches(SessionId.make("missing"))).toHaveLength(0)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back forked branch and copied messages when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-rollback")
      const branchId = BranchId.make("branch-source")
      const messageId = MessageId.make("message-source")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "rollback",
      })
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "seed" })],
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        mutations.forkSessionBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.listBranches(sessionId)).toHaveLength(1)
      expect(yield* messages.listMessages(branchId)).toHaveLength(1)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back session rename when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-rename-rollback")
      const branchId = BranchId.make("branch-rename-rollback")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "before",
      })

      const exit = yield* Effect.exit(mutations.renameSession({ sessionId, name: "after" }))

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.name).toBe("before")
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("a rename keeps a model change that lands between its read and its write", () => {
    const sessionId = SessionId.make("session-rename-race")
    const branchId = BranchId.make("branch-rename-race")
    return Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
        name: "before",
      })

      yield* mutations.renameSession({ sessionId, name: "after" })

      const stored = yield* sessions.getSession(sessionId)
      expect(stored?.name).toBe("after")
      expect(stored?.modelId).toBe(ModelId.make("racer/model"))
    }).pipe(
      Effect.provide(
        interleavedSessionMutationsLayer({
          sessionId,
          racingWrite: (sql) =>
            sql`UPDATE sessions SET model_id = ${"racer/model"} WHERE id = ${sessionId}`,
        }),
      ),
      Effect.timeout("4 seconds"),
    )
  })

  it.live("a settings change keeps a rename that lands between its read and its write", () => {
    const sessionId = SessionId.make("session-settings-race")
    const branchId = BranchId.make("branch-settings-race")
    return Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
        name: "before",
      })

      yield* mutations.updateSettings({
        sessionId,
        modelId: Option.some(ModelId.make("chosen/model")),
        reasoningLevel: Option.some("high"),
      })

      const stored = yield* sessions.getSession(sessionId)
      expect(stored?.name).toBe("renamed meanwhile")
      expect(stored?.modelId).toBe(ModelId.make("chosen/model"))
      expect(stored?.reasoningLevel).toBe("high")
    }).pipe(
      Effect.provide(
        interleavedSessionMutationsLayer({
          sessionId,
          racingWrite: (sql) =>
            sql`UPDATE sessions SET name = ${"renamed meanwhile"} WHERE id = ${sessionId}`,
        }),
      ),
      Effect.timeout("4 seconds"),
    )
  })

  it.live("rolls back active branch switch when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-rollback")
      const fromBranchId = BranchId.make("branch-switch-from")
      const toBranchId = BranchId.make("branch-switch-to")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch",
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rejects active branch switch to a branch outside the session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-owner")
      const otherSessionId = SessionId.make("session-switch-other")
      const fromBranchId = BranchId.make("branch-switch-owner-from")
      const toBranchId = BranchId.make("branch-switch-owner-foreign")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: toBranchId,
        now,
        name: "other",
      })

      const exit = yield* Effect.exit(
        mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back reasoning setting when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-settings-rollback")
      const branchId = BranchId.make("branch-settings-rollback")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "settings",
      })

      const exit = yield* Effect.exit(
        mutations.updateSettings({
          sessionId,
          modelId: Option.none(),
          reasoningLevel: Option.some("high"),
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rejects session creation with parent branch but no parent session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(
        mutations.createSession({
          parentBranchId: BranchId.make("dangling-parent-branch"),
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions).toHaveLength(0)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )
})

// ── session nesting depth ───────────────────────────────────────────────────

describe("session.create nesting depth", () => {
  it.live("spawned child chain stops at the shared agent-run depth cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ cwd: process.cwd() })
        // Root is depth 0; each spawned child nests one level deeper.
        let parent: { sessionId: SessionId; branchId: BranchId } = root
        for (let depth = 1; depth <= DEFAULT_MAX_AGENT_RUN_DEPTH; depth++) {
          parent = yield* client.session.create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
        }
        const error = yield* client.session
          .create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("SessionDepthLimitError")
        expect(error.message).toContain(`max ${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live("a handoff chain past the cap still spawns children", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ cwd: process.cwd() })
        // A handoff continues the parent's thread; it is not a spawn edge.
        let parent: { sessionId: SessionId; branchId: BranchId } = root
        for (let handoff = 1; handoff <= DEFAULT_MAX_AGENT_RUN_DEPTH + 1; handoff++) {
          parent = yield* client.session.create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
            continueThread: true,
          })
        }
        // The last handoff sits at spawn depth 0: it spawns up to the cap.
        for (let depth = 1; depth <= DEFAULT_MAX_AGENT_RUN_DEPTH; depth++) {
          parent = yield* client.session.create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
        }
        const error = yield* client.session
          .create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("SessionDepthLimitError")
        // A child at the cap hands off: the new session keeps its depth.
        const handedOff = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          continueThread: true,
        })
        const past = yield* client.session
          .create({
            cwd: process.cwd(),
            parentSessionId: handedOff.sessionId,
            parentBranchId: handedOff.branchId,
          })
          .pipe(Effect.flip)
        expect(past._tag).toBe("SessionDepthLimitError")
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live("child below the cap still creates a child session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ cwd: process.cwd() })
        const child = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: root.sessionId,
          parentBranchId: root.branchId,
        })
        const stored = yield* client.session.get({ sessionId: child.sessionId })
        expect(stored?.parentSessionId).toBe(root.sessionId)
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )
})

// ── session delete ──────────────────────────────────────────────────────────

describe("session.delete", () => {
  it.live("closes session event streams and removes the session from public queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })
        const closed = yield* collectSessionEvents(
          client.session.events({
            sessionId: created.sessionId,
          }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))

        const deleted = yield* client.session.get({ sessionId: created.sessionId })
        const sessions = yield* client.session.list()

        expect(deleted).toBeNull()
        expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("closes descendant event streams and removes descendants on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const parent = yield* client.session.create({ cwd: process.cwd() })
        const child = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })
        const grandchild = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
        })

        const parentClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: parent.sessionId }),
        )
        const childClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: child.sessionId }),
        )
        const grandchildClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: grandchild.sessionId }),
        )

        yield* client.session.delete({ sessionId: parent.sessionId })

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: parent.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: child.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: grandchild.sessionId })).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("public delete keeps a handoff that continues the session and its runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const parent = yield* client.session.create({ cwd: process.cwd() })
        const handoff = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          continueThread: true,
        })
        const spawn = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })

        yield* client.session.delete({ sessionId: parent.sessionId })

        expect(yield* client.session.get({ sessionId: spawn.sessionId })).toBeNull()
        const kept = yield* client.session.get({ sessionId: handoff.sessionId })
        expect(kept?.parentSessionId).toBeUndefined()
        // The handoff's runtime was never stopped: it still takes a turn.
        yield* client.message.send({
          sessionId: handoff.sessionId,
          branchId: handoff.branchId,
          content: "still here",
        })
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("closes runtime streams and interrupts active loops on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } =
          yield* LanguageModelLayers.signal("delete me later")
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })
        const runtimeClosed = yield* collectSessionEvents(
          client.session.watchRuntime({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
        )

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "start an active loop before delete",
        })
        yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(runtimeClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: created.sessionId })).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("is idempotent when deleting an already deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* client.session.delete({ sessionId: created.sessionId })
        const deleted = yield* client.session.get({ sessionId: created.sessionId })

        expect(deleted).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("cleans runtime state for descendant sessions before durable cascade", () => {
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const eventStore = yield* EventStore

        const parent = yield* mutations.createSession({ cwd: "/nonexistent/delete-parent" })
        const child = yield* mutations.createSession({
          cwd: "/nonexistent/delete-child",
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })
        const grandchild = yield* mutations.createSession({
          cwd: "/nonexistent/delete-grandchild",
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
        })

        const primeSessionStream = Effect.fn("primeSessionStream")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const closed = collectSessionEvents(eventStore.subscribe({ sessionId }))
          yield* eventStore.publish(SessionStarted.make({ sessionId, branchId }))
          return yield* closed
        })

        const parentClosed = yield* primeSessionStream(parent.sessionId, parent.branchId)
        const childClosed = yield* primeSessionStream(child.sessionId, child.branchId)
        const grandchildClosed = yield* primeSessionStream(
          grandchild.sessionId,
          grandchild.branchId,
        )

        yield* mutations.deleteSession(parent.sessionId)

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))
        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId, grandchild.sessionId])
      }).pipe(
        Effect.provide(sessionMutationsLayerWithMachineProbe(runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("cleans runtime state for a child created mid-cascade", () => {
    const runtimeTerminated: Array<SessionId> = []
    const lateChildSessionId = SessionId.make("race-late-child")
    const lateChildBranchId = BranchId.make("race-late-child-branch")
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessions = yield* SessionStorage

        const parent = yield* mutations.createSession({ cwd: "/nonexistent/race-parent" })

        yield* mutations.deleteSession(parent.sessionId)

        expect(yield* sessions.getSession(parent.sessionId)).toBeUndefined()
        expect(yield* sessions.getSession(lateChildSessionId)).toBeUndefined()
        expect(runtimeTerminated.sort()).toEqual([parent.sessionId, lateChildSessionId].sort())
      }).pipe(
        Effect.provide(
          racySessionMutationsLayer({
            runtimeTerminated,
            lateChild: {
              sessionId: lateChildSessionId,
              branchId: lateChildBranchId,
            },
          }),
        ),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("cleans runtime state for mutation deletes used by extension hosts", () => {
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const now = FIXED_NOW
        const parent = {
          sessionId: SessionId.make("mutation-delete-parent"),
          branchId: BranchId.make("mutation-delete-parent-branch"),
        }

        yield* createActiveSessionFixture({ ...parent, sessions, branches, now })
        const child = {
          sessionId: SessionId.make("mutation-delete-child"),
          branchId: BranchId.make("mutation-delete-child-branch"),
        }
        yield* createActiveSessionFixture({
          ...child,
          sessions,
          branches,
          now,
          cwd: "/nonexistent/mutation-delete-child",
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })

        yield* mutations.deleteSession(parent.sessionId)

        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId])
      }).pipe(
        Effect.provide(sessionMutationsLayerWithMachineProbe(runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("restores runtime tombstones when durable delete fails", () => {
    const runtimeTerminated: Array<SessionId> = []
    const runtimeRestored: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("delete-failure-session")
        const branchId = BranchId.make("delete-failure-branch")

        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })

        const exit = yield* Effect.exit(mutations.deleteSession(sessionId))

        expect(exit._tag).toBe("Failure")
        expect(runtimeTerminated).toEqual([sessionId])
        expect(runtimeRestored).toEqual([sessionId])
        expect(yield* sessions.getSession(sessionId)).not.toBeUndefined()
      }).pipe(
        Effect.provide(
          failingDeleteSessionMutationsLayerWithMachineProbe(runtimeTerminated, runtimeRestored),
        ),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live(
    "rejects public read boundaries for deleted sessions (events, watchRuntime, getSnapshot, queue.get)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })
          yield* client.session.delete({ sessionId: created.sessionId })

          const expectSessionNotFound = (exit: {
            readonly _tag: "Success" | "Failure"
            readonly cause?: Cause.Cause<unknown>
          }) => {
            expect(exit._tag).toBe("Failure")
            if (exit._tag === "Failure" && !Predicate.isUndefined(exit.cause)) {
              const message = String(Cause.squash(exit.cause))
              expect(message.toLowerCase()).toMatch(/session.*(not found|terminated)/)
            }
          }

          const eventsExit = yield* Effect.exit(
            client.session
              .events({ sessionId: created.sessionId })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(eventsExit)

          const watchExit = yield* Effect.exit(
            client.session
              .watchRuntime({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(watchExit)

          const snapshotExit = yield* Effect.exit(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(snapshotExit)

          const queueExit = yield* Effect.exit(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(queueExit)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("terminates an active subscription mid-delete (subscribe-then-delete race)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        // Subscribe while the session is alive, then delete it while
        // the stream is still attached. The subscription must terminate
        // (either via interruption on loop close, or by the event-store
        // propagating session-gone). A hang means the principle of
        // terminal-state-exit-safety is violated.
        const closed = yield* collectSessionEvents(
          client.session.events({ sessionId: created.sessionId }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── session event stream ────────────────────────────────────────────────────

/**
 * What `client.session.events` delivers around a real turn.
 *
 * `domain/event-stream-delivery.test.ts` proves the store's replay, cursor and
 * branch filter with synthetic events; `extension-commands-rpc.test.ts` proves
 * the RPC stream marks the replay-to-live move. This file covers what neither
 * can: which events a real turn leaves in the replay buffer, that the stream
 * stays live past `TurnCompleted`, and that chunks published during the
 * replay-to-live handoff are not dropped.
 */

// `retries: false` turns off the debug model's synthetic 429s, which fire on
// a hash of the user text; without it a message's own wording decides whether
// the turn retries.
const makeDebugClient = () =>
  createRpcClient(
    createE2ELayer({
      ...e2ePreset,
      providerLayer: LanguageModelLayers.debug({ retries: false }),
    }),
  )

const startCollecting = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Ref.Ref<A[]>, E, Scope.Scope> =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()
    yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          yield* Ref.update(values, (current) => [...current, value])
          yield* Deferred.succeed(ready, void 0).pipe(Effect.ignore)
        }),
      ),
      Effect.forkScoped,
    )
    // Resolve once the first value has been written into `values`. Cap at 50ms
    // because events-after-cursor only emits when new events are appended --
    // downstream waitFor() polls absorb any remaining race.
    yield* Deferred.await(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

const waitForTaggedEvent = (
  events: Ref.Ref<EventEnvelope[]>,
  tag: EventEnvelope["event"]["_tag"],
  afterId = Option.none<number>(),
) =>
  waitFor(Ref.get(events), (current) =>
    current.some(
      (envelope) =>
        envelope.event._tag === tag && (Option.isNone(afterId) || envelope.id > afterId.value),
    ),
  )

describe("session event stream", () => {
  it.live(
    "replays a completed turn's stream start, message and completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "replay this turn",
          })

          yield* waitFor(client.message.list({ branchId: created.branchId }), (messages) =>
            messages.some((message) => message.role === "assistant"),
          )

          const buffered = yield* startCollecting(
            client.session.events({ sessionId: created.sessionId }),
          )
          const replayed = yield* waitForTaggedEvent(buffered, "TurnCompleted")

          expect(replayed.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
          expect(replayed.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(true)
          expect(replayed.some((envelope) => envelope.event._tag === "TurnCompleted")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "a live stream keeps delivering session events after a turn completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          const live = yield* startCollecting(
            client.session.events({ sessionId: created.sessionId }),
          )

          yield* client.branch.create({
            sessionId: created.sessionId,
            name: "stream-ready-branch",
          })
          const ready = yield* waitForTaggedEvent(live, "BranchCreated")
          const readyId = Option.fromNullishOr(ready[ready.length - 1]?.id)

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "finish one turn",
          })

          const firstTurn = yield* waitForTaggedEvent(live, "TurnCompleted", readyId)
          const firstTurnMaxId = Option.fromNullishOr(firstTurn[firstTurn.length - 1]?.id)

          expect(Option.isSome(firstTurnMaxId)).toBe(true)

          // This asserts stream liveness, not actor command timing. Use a
          // session event outside the turn loop to prove the stream stays alive.
          yield* client.branch.create({
            sessionId: created.sessionId,
            name: "stream-live-branch",
          })

          const combined = yield* waitFor(
            Ref.get(live),
            (current) =>
              Option.isSome(firstTurnMaxId) &&
              current.some(
                (envelope) =>
                  envelope.id > firstTurnMaxId.value && envelope.event._tag === "BranchCreated",
              ),
          )

          expect(
            combined.some(
              (envelope) =>
                Option.isSome(firstTurnMaxId) &&
                envelope.id > firstTurnMaxId.value &&
                envelope.event._tag === "BranchCreated",
            ),
          ).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "subscribing at the latest cursor replays nothing and delivers the next message live",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.branch.create({ sessionId: created.sessionId, name: "before-live" })

          const snapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })

          const live = yield* startCollecting(
            client.session.events({
              sessionId: created.sessionId,
              branchId: created.branchId,
              after: Option.getOrUndefined(Option.fromNullishOr(snapshot.lastEventId)),
            }),
          )

          // Any events replayed in the initial window must respect the cursor.
          const initial = yield* Ref.get(live)
          const afterId = Option.getOrElse(Option.fromNullishOr(snapshot.lastEventId), () => 0)
          expect(initial.every((envelope) => envelope.id > afterId)).toBe(true)

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "after-live",
          })

          const received = yield* waitFor(
            Ref.get(live),
            (current) => current.some((envelope) => envelope.event._tag === "MessageReceived"),
            13_000,
          )

          expect(received.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  // The replay-to-live handoff needs StreamChunk events to be observed while
  // the turn is still in flight. The signal model gates each chunk so the test
  // releases them on demand instead of paying real wall-clock per chunk.
  it.live(
    "streamed chunks survive the replay-to-live handoff",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } =
            yield* LanguageModelLayers.signal("handoff payload.")
          const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
          const created = yield* client.session.create({ cwd: process.cwd() })

          const snapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })

          const live = yield* startCollecting(
            client.session.events({
              sessionId: created.sessionId,
              branchId: created.branchId,
              after: Option.getOrUndefined(Option.fromNullishOr(snapshot.lastEventId)),
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "after-live-chunks",
          })

          // Wait for the stream to start, then release the chunks.
          yield* controls.waitForStreamStart
          yield* controls.emitAll

          const received = yield* waitFor(
            Ref.get(live),
            (current) => current.some((envelope) => envelope.event._tag === "StreamChunk"),
            13_000,
          )

          expect(received.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
          expect(received.some((envelope) => envelope.event._tag === "StreamChunk")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )
})

// ── session queue watch ─────────────────────────────────────────────────────

/**
 * The queue as a client reads it, while a turn is still in flight.
 *
 * `session-idempotency.test.ts` covers `queue.drain` for steering entries and
 * `runtime/session-runtime.test.ts` covers follow-up draining at the service
 * level. This file covers the public pair neither does: two follow-ups queued
 * mid-turn, read back in order through `queue.get` and returned in the same
 * order by `queue.drain`, and the follow-up queue reaching a client through
 * the `watchRuntime` stream rather than a poll.
 */

/**
 * The signal model gates every chunk on a queue, so the first turn stays in
 * flight until the test releases it. That is what lets a second `message.send`
 * land as a queued follow-up rather than starting its own turn.
 */
const makeSignalClient = (reply: string) =>
  Effect.gen(function* () {
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(reply)
    const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
    return { client, controls }
  })

const flattenRestoreText = (snapshot: {
  steering: ReadonlyArray<{ content: string }>
  followUp: ReadonlyArray<{ content: string }>
}) => [...snapshot.steering, ...snapshot.followUp].map((entry) => entry.content).join("\n")

const collectRuntimeQueueWatch = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Ref.Ref<A[]>, E, Scope.Scope> =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()
    yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          yield* Ref.update(values, (current) => [...current, value])
          yield* Deferred.succeed(ready, void 0).pipe(Effect.ignore)
        }),
      ),
      Effect.forkScoped,
    )
    // watchRuntime emits the current snapshot on subscribe, so this typically
    // resolves in <1ms. Cap at 50ms as a safety net.
    yield* Deferred.await(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

describe("session queue and runtime watch", () => {
  it.live(
    "two follow-ups queued mid-turn keep their order through queue.get and queue.drain",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, controls } = yield* makeSignalClient("done.")
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntimeQueueWatch(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          // Wait for the stream to start so the runtime is genuinely non-idle.
          yield* controls.waitForStreamStart

          yield* waitFor(
            Ref.get(runtime),
            (states) => states.some((state) => state._tag !== "Idle"),
            10_000,
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued a",
          })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued b",
          })

          const queued = yield* waitFor(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => flattenRestoreText(snapshot) === "queued a\nqueued b",
            10_000,
          )

          expect(queued.steering).toEqual([])
          expect(flattenRestoreText(queued)).toBe("queued a\nqueued b")

          const drained = yield* client.queue.drain({
            sessionId: created.sessionId,
            branchId: created.branchId,
            requestId: "req-queue-contract-drain",
          })

          expect(flattenRestoreText(drained)).toBe("queued a\nqueued b")

          const afterDrain = yield* waitFor(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            10_000,
          )

          expect(afterDrain.steering).toEqual([])
          expect(afterDrain.followUp).toEqual([])

          // Release the stream so the run can complete and scope cleanup is fast.
          yield* controls.emitAll
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )

  it.live(
    "watchRuntime pushes a queued follow-up out to the client mid-turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, controls } = yield* makeSignalClient("done.")
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntimeQueueWatch(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          const initial = yield* waitFor(
            Ref.get(runtime),
            (current) => current[0]?._tag === "Idle",
            10_000,
          )
          expect(initial[0]?._tag).toBe("Idle")
          expect(initial[0]?.queue.followUp).toEqual([])
          expect(initial[0]?.queue.steering).toEqual([])

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          // Stream is now paused mid-flight on the chunk gate.
          yield* controls.waitForStreamStart

          yield* waitFor(
            Ref.get(runtime),
            (current) => current.some((state) => state._tag !== "Idle"),
            10_000,
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          const updated = yield* waitFor(
            Ref.get(runtime),
            (current) =>
              current.some((state) =>
                state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
              ),
            10_000,
          )

          expect(
            updated.some((state) =>
              state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
            ),
          ).toBe(true)

          // Release chunks for both turns so scope cleanup is fast.
          yield* controls.emitAll
          yield* controls.emitAll
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )
})

// ── session transport contract ──────────────────────────────────────────────

/**
 * The public read surface a client sees around one session.
 *
 * `message-send.test.ts` proves a turn persists; this proves the queries a
 * client reads it back through -- `session.list`, `session.get`,
 * `session.getSnapshot`, `queue.get` and `message.list` -- agree with each
 * other and with the session that was just created, and that two sessions on
 * two working directories stay apart.
 */

// The debug model answers every turn, so a test may send more than one
// message without scripting a step per send. `retries: false` turns off its
// synthetic 429s, which fire on a hash of the user text and would otherwise
// make a message's own wording decide whether the turn retries.
describe("session transport contract", () => {
  it.live(
    "a created session appears in list and get with an empty snapshot and queue",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const initialSessions = yield* client.session.list()

          const created = yield* client.session.create({ cwd: process.cwd() })

          const sessions = yield* client.session.list()
          const createdSession = sessions.find((session) => session.id === created.sessionId)

          expect(createdSession).toBeDefined()
          expect(sessions.length).toBe(initialSessions.length + 1)
          expect(createdSession?.activeBranchId).toBe(created.branchId)

          const loaded = yield* client.session.get({ sessionId: created.sessionId })
          expect(loaded?.id).toBe(created.sessionId)
          expect(loaded?.activeBranchId).toBe(created.branchId)

          const initialSnapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(initialSnapshot.messages).toEqual([])
          expect(initialSnapshot.branchId).toBe(created.branchId)
          expect(initialSnapshot.sessionId).toBe(created.sessionId)

          const initialQueue = yield* client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(initialQueue.followUp).toEqual([])
          expect(initialQueue.steering).toEqual([])
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "a sent message is readable through message.list and the session snapshot, and leaves the queue empty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "hello from the transport contract",
          })

          const messages = yield* waitFor(
            client.message.list({ branchId: created.branchId }),
            (items) =>
              items.some(
                (message) =>
                  messagePartsText(message.parts) === "hello from the transport contract",
              ),
          )

          expect(
            messages.some((message) => {
              if (message.role !== "user") return false
              return messagePartsText(message.parts) === "hello from the transport contract"
            }),
          ).toBe(true)

          yield* waitFor(client.message.list({ branchId: created.branchId }), (items) =>
            items.some((message) => message.role === "assistant"),
          )

          yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (state) =>
              state.messages.some(
                (message) =>
                  message.role === "user" &&
                  messagePartsText(message.parts) === "hello from the transport contract",
              ),
          )

          const queueAfterSend = yield* client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(queueAfterSend.followUp).toEqual([])
          expect(queueAfterSend.steering).toEqual([])
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  // Two sessions on two distinct cwds must have independent per-session
  // profile + event routing -- a regression to launch-cwd-only event
  // delivery (where session B's events leak into session A's stream)
  // would fail this test.
  it.live(
    "two sessions on distinct cwds isolate snapshots and events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeDebugClient()
          const cwdA = yield* makeTempDirectoryScoped("gent-secondary-A-")
          const cwdB = yield* makeTempDirectoryScoped("gent-secondary-B-")
          const a = yield* client.session.create({ cwd: cwdA })
          const b = yield* client.session.create({ cwd: cwdB })
          expect(a.sessionId).not.toBe(b.sessionId)

          yield* client.message.send({
            sessionId: a.sessionId,
            branchId: a.branchId,
            content: "msg-A",
          })
          yield* client.message.send({
            sessionId: b.sessionId,
            branchId: b.branchId,
            content: "msg-B",
          })

          // Each session's snapshot must contain ONLY its own user message.
          // A regression where event-store fanout sends events to the wrong
          // session's stream would surface here.
          //
          // Wait until BOTH sessions have observed their own message before
          // running absence checks. If we only checked A first, a delayed
          // mis-routed msg-B could arrive into A's stream after the first
          // poll succeeded but before the absence check ran, masking a
          // genuine routing leak.
          yield* waitFor(
            client.session.getSnapshot({ sessionId: b.sessionId, branchId: b.branchId }),
            (s) =>
              s.messages.some((m) => m.role === "user" && messagePartsText(m.parts) === "msg-B"),
          )
          const snapshotA = yield* waitFor(
            client.session.getSnapshot({ sessionId: a.sessionId, branchId: a.branchId }),
            (s) =>
              s.messages.some((m) => m.role === "user" && messagePartsText(m.parts) === "msg-A"),
          )
          const snapshotB = yield* client.session.getSnapshot({
            sessionId: b.sessionId,
            branchId: b.branchId,
          })
          expect(
            snapshotA.messages.every(
              (m) => m.role !== "user" || messagePartsText(m.parts) !== "msg-B",
            ),
          ).toBe(true)
          expect(
            snapshotB.messages.every(
              (m) => m.role !== "user" || messagePartsText(m.parts) !== "msg-A",
            ),
          ).toBe(true)

          // Sessions are listed under both cwds.
          const sessions = yield* client.session.list()
          const sa = sessions.find((s) => s.id === a.sessionId)
          const sb = sessions.find((s) => s.id === b.sessionId)
          expect(sa?.cwd).toBe(cwdA)
          expect(sb?.cwd).toBe(cwdB)
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )
})

// ── request idempotency ─────────────────────────────────────────────────────

describe("requestId idempotency", () => {
  const makePersistentSessionMutationsLayer = (dbPath: string) => {
    const storageLayer = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(GentPlatform.Test()),
    )
    const deps = Layer.mergeAll(
      storageLayer,
      sessionRuntimeLayer(),
      EventStore.Memory,
      EventStore.Memory,
      AgentLoopSessionGovernance.Live,
      LanguageModelLayers.debug(),
      ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
      GentPlatform.Test(),
      ExtensionRegistry.Test(),
    )
    return Layer.provideMerge(SessionMutationsLive, deps)
  }

  it.live("duplicate createSession requestId converges on a single session id", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const first = yield* mutations.createSession({
        cwd: "/nonexistent/idem",
        requestId: "req-create-1",
      })
      const second = yield* mutations.createSession({
        cwd: "/nonexistent/idem",
        requestId: "req-create-1",
      })
      const third = yield* mutations.createSession({
        cwd: "/nonexistent/idem",
        requestId: "req-create-1",
      })
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.branchId).toBe(first.branchId)
      expect(third.sessionId).toBe(first.sessionId)
      const all = yield* sessions.listSessions
      expect(all).toHaveLength(1)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("a retried create replays its receipt after its agent is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reviewer = AgentName.make("reviewer")
        const reviewerExtension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/reviewer-agent") },
          scope: "project",
          sourcePath: "test",
          contributions: { agents: [AgentDefinition.make({ name: reviewer })] },
        }
        // One database; the process that retries no longer loads the agent.
        const shared = yield* Layer.build(
          Layer.mergeAll(
            testSqliteStorage(() => Layer.empty, {}),
            sessionRuntimeLayer(),
            EventStore.Memory,
            EventStore.Memory,
            AgentLoopSessionGovernance.Live,
            LanguageModelLayers.debug(),
            ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
            GentPlatform.Test(),
          ),
        )
        const create = (registry: Layer.Layer<ExtensionRegistry>, requestId: string) =>
          Effect.flatMap(SessionMutations, (mutations) =>
            mutations.createSession({
              cwd: "/nonexistent/retry",
              admission: { agent: reviewer },
              requestId,
            }),
          ).pipe(
            Effect.provide(
              Layer.provide(
                SessionMutationsLive,
                Layer.merge(Layer.succeedContext(shared), registry),
              ),
            ),
          )
        const withReviewer = ExtensionRegistry.fromResolved(resolveExtensions([reviewerExtension]))
        const first = yield* create(withReviewer, "req-retry")
        const retried = yield* create(ExtensionRegistry.Test(), "req-retry")
        expect(retried.sessionId).toBe(first.sessionId)
        // A fresh create is still checked.
        const error = yield* create(ExtensionRegistry.Test(), "req-fresh").pipe(Effect.flip)
        expect(error.message).toBe("Unknown agent: reviewer")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a create admits an agent its cwd's profile has and the launch registry lacks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reviewer = AgentName.make("reviewer")
        const resolved = resolveExtensions([
          {
            manifest: { id: ExtensionId.make("@test/reviewer-agent") },
            scope: "project",
            sourcePath: "test",
            contributions: { agents: [AgentDefinition.make({ name: reviewer })] },
          },
        ])
        const layerContext = yield* Layer.build(ExtensionRegistry.fromResolved(resolved))
        const profile: SessionProfile = {
          cwd: "/nonexistent/profiled",
          resolved,
          layerContext,
          registryService: Context.get(layerContext, ExtensionRegistry),
          baseSections: [],
          generationId: ProcessGenerationId.make("test"),
        }
        const profiles = Layer.succeed(
          SessionProfileCache,
          SessionProfileCache.of({ resolve: () => Effect.succeed(profile) }),
        )
        const deps = Layer.mergeAll(
          testSqliteStorage(() => Layer.empty, {}),
          sessionRuntimeLayer(),
          EventStore.Memory,
          EventStore.Memory,
          AgentLoopSessionGovernance.Live,
          LanguageModelLayers.debug(),
          ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
          GentPlatform.Test(),
          ExtensionRegistry.Test(),
          profiles,
        )
        // The caller holds only SessionMutations: the check reads the cache
        // the service captured, not one from the caller's context.
        const create = (layer: typeof deps) =>
          Effect.flatMap(SessionMutations, (mutations) =>
            mutations.createSession({
              cwd: "/nonexistent/profiled",
              admission: { agent: reviewer },
            }),
          ).pipe(Effect.provide(Layer.provide(SessionMutationsLive, layer)))
        const created = yield* create(deps)
        expect(created.sessionId).toBeDefined()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("distinct createSession requestIds create distinct sessions", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const a = yield* mutations.createSession({ cwd: "/nonexistent/a", requestId: "req-a" })
      const b = yield* mutations.createSession({ cwd: "/nonexistent/b", requestId: "req-b" })
      expect(a.sessionId).not.toBe(b.sessionId)
      expect((yield* sessions.listSessions).length).toBe(2)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createSession requestIds converge on one session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      // Fire three parallel creates with the same requestId. Before the
      // Deferred-based claim this would race two `Ref.get` misses through
      // storage and leave two sessions. Under the atomic claim the first
      // fiber wins the write; the others `Deferred.await` its outcome.
      const results = yield* Effect.all(
        [
          mutations.createSession({ cwd: "/nonexistent/conc", requestId: "req-conc-1" }),
          mutations.createSession({ cwd: "/nonexistent/conc", requestId: "req-conc-1" }),
          mutations.createSession({ cwd: "/nonexistent/conc", requestId: "req-conc-1" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].sessionId).toBe(results[1].sessionId)
      expect(results[0].sessionId).toBe(results[2].sessionId)
      expect((yield* sessions.listSessions).length).toBe(1)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("duplicate public message.send requestId dispatches to the runtime only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let dispatchCount = 0
        const { client, inWorkspace } = yield* makeRpcHandlersClient({
          sendUserMessage: () =>
            Effect.sync(() => {
              dispatchCount++
            }),
        })
        const send = (content: string, requestId: string) =>
          inWorkspace(
            client["message.send"]({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content,
              requestId,
            }),
          )

        yield* send("hi", "req-send-1")
        yield* send("hi", "req-send-1")
        yield* send("hi (distinct)", "req-send-2")

        expect(dispatchCount).toBe(2)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("concurrent duplicate public message.send requestIds dispatch only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let dispatchCount = 0
        const { client, inWorkspace } = yield* makeRpcHandlersClient({
          sendUserMessage: () =>
            Effect.sync(() => {
              dispatchCount++
            }),
        })
        const send = inWorkspace(
          client["message.send"]({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            content: "hi",
            requestId: "req-conc-send",
          }),
        )

        yield* Effect.all([send, send, send], { concurrency: "unbounded" })

        expect(dispatchCount).toBe(1)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate createBranch requestId converges on a single branch id", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-dedup")
      const branchId = BranchId.make("branch-branch-dedup")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
      })

      const first = yield* mutations.createSessionBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })
      const second = yield* mutations.createSessionBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // 1 from fixture + 1 from the deduped create
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createBranch requestIds converge on one branch", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-conc")
      const branchId = BranchId.make("branch-branch-conc")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
      })

      const results = yield* Effect.all(
        [
          mutations.createSessionBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          mutations.createSessionBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          mutations.createSessionBranch({ sessionId, name: "x", requestId: "req-bconc" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].branchId).toBe(results[1].branchId)
      expect(results[0].branchId).toBe(results[2].branchId)
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("duplicate switchBranch requestId activates the target only once", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-dedup")
      const fromBranchId = BranchId.make("branch-switch-dedup-from")
      const toBranchId = BranchId.make("branch-switch-dedup-to")
      const now = FIXED_NOW
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      yield* mutations.switchActiveBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        requestId: "req-switch-1",
      })
      yield* mutations.switchActiveBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        requestId: "req-switch-1",
      })

      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(toBranchId)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("duplicate forkBranch requestId converges on a single new branch", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-fork-dedup")
      const branchId = BranchId.make("branch-fork-dedup")
      const messageId = MessageId.make("message-fork-dedup")
      const now = FIXED_NOW
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
      })
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "seed" })],
          createdAt: now,
        }),
      )

      const first = yield* mutations.forkSessionBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })
      const second = yield* mutations.forkSessionBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // origin + 1 forked branch
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("duplicate public branch.create requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/nonexistent/rpc-branch-create-idem" })

        const first = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "rpc durable branch",
          requestId: "req-rpc-create-branch",
        })
        const second = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "retry name should not win",
          requestId: "req-rpc-create-branch",
        })
        const branches = yield* client.branch.list({ sessionId: created.sessionId })

        expect(second.branchId).toBe(first.branchId)
        expect(branches).toHaveLength(2)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public branch.switch requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/nonexistent/rpc-branch-switch-idem" })
        const target = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "target",
          requestId: "req-rpc-switch-target-create",
        })

        yield* client.branch.switch({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          toBranchId: target.branchId,
          requestId: "req-rpc-switch-branch",
        })
        yield* client.branch.switch({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          toBranchId: target.branchId,
          requestId: "req-rpc-switch-branch",
        })
        const session = yield* client.session.get({ sessionId: created.sessionId })

        expect(session?.activeBranchId).toBe(target.branchId)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public branch.fork requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/nonexistent/rpc-branch-fork-idem" })
        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "seed public fork",
          requestId: "req-rpc-fork-seed-message",
        })
        const snapshot = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        const userMessage = snapshot.messages.find((message) => message.role === "user")
        if (Predicate.isUndefined(userMessage)) {
          return yield* Effect.die("expected seeded user message")
        }

        const first = yield* client.branch.fork({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          atMessageId: userMessage.id,
          name: "rpc durable fork",
          requestId: "req-rpc-fork-branch",
        })
        const second = yield* client.branch.fork({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          atMessageId: userMessage.id,
          name: "retry fork name should not win",
          requestId: "req-rpc-fork-branch",
        })
        const branches = yield* client.branch.list({ sessionId: created.sessionId })

        expect(second.branchId).toBe(first.branchId)
        expect(branches).toHaveLength(2)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public steer Interject requestId queues at most once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/nonexistent/rpc-steer-idem" })

        const command = {
          _tag: "Interject",
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-steer-interject",
          message: "steer once",
        } satisfies SteerCommand
        yield* client.steer.command({ command })
        yield* client.steer.command({ command })

        const queued = yield* waitFor(
          client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (snapshot) => snapshot.steering.length === 1,
          1_000,
          "public steer command enqueue",
        )
        expect(queued.steering.map((entry) => entry.content)).toEqual(["steer once"])

        yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-steer-drain",
        })
        yield* client.steer.command({ command })
        const afterRetry = yield* client.queue.get({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(afterRetry.steering).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public queue.drain requestId replays the original snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/nonexistent/rpc-drain-idem" })
        yield* client.steer.command({
          command: {
            _tag: "Interject",
            sessionId: created.sessionId,
            branchId: created.branchId,
            requestId: "req-rpc-drain-steer",
            message: "drain me",
          },
        })

        const first = yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-drain-queue",
        })
        const second = yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-drain-queue",
        })
        const current = yield* client.queue.get({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })

        expect(first.steering.map((entry) => entry.content)).toEqual(["drain me"])
        expect(second).toEqual(first)
        expect(current.steering).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  // Fresh process cache. createSession has a durable operation result
  // underneath the in-memory process cache, so a retry of the same
  // `requestId` still returns the original session/branch ids after the
  // cache is gone. Each `Effect.provide` of the layer builds a new
  // `SessionMutations` (new dedup cache) over the same SQLite file.
  it.scoped("durable createSession result survives a fresh process cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionMutationsLayer(dbPath)
      const create = Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.createSession({ cwd: "/nonexistent/ttl", requestId: "req-ttl-1" })
      })

      const first = yield* create.pipe(Effect.provide(layer))
      const second = yield* create.pipe(Effect.provide(layer))
      const sessions = yield* Effect.gen(function* () {
        const storage = yield* SessionStorage
        return yield* storage.listSessions
      }).pipe(Effect.provide(layer))

      expect(second.sessionId).toBe(first.sessionId)
      expect(second.branchId).toBe(first.branchId)
      expect(sessions).toHaveLength(1)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  // Companion to the TTL eviction test: prove the bound is the bound.
  // Within the 60s window, a retry MUST collapse onto the cached outcome
  // — otherwise "evict past TTL" would be vacuous.
  it.effect("dedup cache retains success entry within TTL — retried requestId collapses", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const first = yield* mutations.createSession({
        cwd: "/nonexistent/ttl-mid",
        requestId: "req-ttl-mid",
      })
      // Advance well inside the 60s window — should still hit the cache.
      yield* TestClock.adjust("30 seconds")
      const second = yield* mutations.createSession({
        cwd: "/nonexistent/ttl-mid",
        requestId: "req-ttl-mid",
      })
      expect(second.sessionId).toBe(first.sessionId)
      expect((yield* sessions.listSessions).length).toBe(1)
    }).pipe(Effect.provide(sessionMutationsLayer)),
  )

  it.effect("dedup cache hard cap evicts the oldest requestId", () =>
    Effect.gen(function* () {
      let value = 0
      const run = yield* makeRequestDeduper<{ requestId: string }, number, never>({
        body: () =>
          Effect.sync(() => {
            value += 1
            return value
          }),
        keyOf: (input) => Option.some(input.requestId),
      })

      // The cap is 1024 entries: fill it, then add one more.
      const first = yield* run({ requestId: "req-cap-0" })
      for (let index = 1; index <= 1024; index += 1) {
        yield* run({ requestId: `req-cap-${index}` })
      }
      expect(value).toBe(1025)

      // Past the cap, "req-cap-0" was evicted to make room for
      // "req-cap-1024", so this call is a fresh lookup, not a cache hit.
      const retry = yield* run({ requestId: "req-cap-0" })
      expect(retry).not.toBe(first)
      expect(retry).toBe(1026)
    }),
  )

  // Regression: a same-key retry inside the TTL window must collapse onto
  // the cached outcome AND must not let a stale body leak into pending such
  // that a post-eviction retry runs the wrong body.
  it.effect("dedup cache post-eviction retry runs the fresh body, not a stale one", () =>
    Effect.gen(function* () {
      // The body's identity is captured in `lastSeen` so we can prove which
      // input arg triggered the lookup. If the post-eviction call ran a
      // stale closure, `lastSeen` would show input1's marker, not input3's.
      let lastSeen = ""
      const run = yield* makeRequestDeduper<{ requestId: string; marker: string }, string, never>({
        body: (input) =>
          Effect.sync(() => {
            lastSeen = input.marker
            return input.marker
          }),
        keyOf: (input) => Option.some(input.requestId),
      })

      // F1 populates the cache with key="K", body uses marker="m1".
      const first = yield* run({ requestId: "K", marker: "m1" })
      expect(first).toBe("m1")
      expect(lastSeen).toBe("m1")

      // F2 retries the same key inside the TTL window — must hit the cache
      // and observe F1's outcome. F2's body (marker="m2") must NOT run.
      const second = yield* run({ requestId: "K", marker: "m2" })
      expect(second).toBe("m1")
      expect(lastSeen).toBe("m1")

      // Advance past the TTL so F1's cache entry is gone. F3 must run a
      // fresh lookup with ITS OWN body (marker="m3"). If F2's body leaked
      // into pending, this would observe "m2" instead of "m3".
      yield* TestClock.adjust("61 seconds")
      const third = yield* run({ requestId: "K", marker: "m3" })
      expect(third).toBe("m3")
      expect(lastSeen).toBe("m3")
    }),
  )

  it.scoped("createSession requestId replays durable result after mutations layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const deliveredPrompts: string[] = []
      const deliveredPromptRequestIds = new Set<string>()

      const makeLayer = (failPrompt: boolean) => {
        const storageLayer = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
          Layer.provide(BunServices.layer),
          Layer.provide(GentPlatform.Test()),
        )
        const runtimeLayer = sessionRuntimeLayer({
          sendUserMessage: (input) => {
            if (failPrompt) {
              return Effect.fail(new SessionRuntimeError({ message: "prompt dispatch failed" }))
            }
            return Effect.sync(() => {
              const key = input.requestId ?? ""
              if (deliveredPromptRequestIds.has(key)) return
              deliveredPromptRequestIds.add(key)
              deliveredPrompts.push(`${input.content}:${key}`)
            })
          },
        })
        const deps = Layer.mergeAll(
          storageLayer,
          runtimeLayer,
          EventStore.Memory,
          EventStore.Memory,
          AgentLoopSessionGovernance.Live,
          LanguageModelLayers.debug(),
          ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
          GentPlatform.Test(),
          ExtensionRegistry.Test(),
        )
        return Layer.provideMerge(SessionMutationsLive, deps)
      }

      const firstExit = yield* Effect.exit(
        Effect.gen(function* () {
          const mutations = yield* SessionMutations
          yield* mutations.createSession({
            cwd: "/nonexistent/restart-create",
            requestId: "req-create-restart",
            initialPrompt: "stored prompt",
          })
        }).pipe(Effect.provide(makeLayer(true))),
      )
      expect(firstExit._tag).toBe("Failure")

      const second = yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.createSession({
          cwd: "/nonexistent/restart-create",
          requestId: "req-create-restart",
          initialPrompt: "retry prompt should not win",
        })
      }).pipe(Effect.provide(makeLayer(false)))

      const sessions = yield* Effect.gen(function* () {
        const storage = yield* SessionStorage
        return yield* storage.listSessions
      }).pipe(Effect.provide(makeLayer(false)))

      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.id).toBe(second.sessionId)
      expect(sessions[0]?.activeBranchId).toBe(second.branchId)
      expect(deliveredPrompts).toEqual(["stored prompt:session.create:req-create-restart:initial"])
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("createBranch requestId replays durable result after mutations layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionMutationsLayer(dbPath)
      const sessionId = SessionId.make("session-create-branch-restart")
      const branchId = BranchId.make("branch-create-branch-restart")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })
      }).pipe(Effect.provide(layer))

      const first = yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.createSessionBranch({
          sessionId,
          name: "durable branch",
          requestId: "req-create-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      const second = yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.createSessionBranch({
          sessionId,
          name: "retry name should not win",
          requestId: "req-create-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      const branches = yield* Effect.gen(function* () {
        const storage = yield* BranchStorage
        return yield* storage.listBranches(sessionId)
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      expect(second.branchId).toBe(first.branchId)
      expect(branches).toHaveLength(2)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("switchBranch requestId replays durable result after mutations layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionMutationsLayer(dbPath)
      const sessionId = SessionId.make("session-switch-branch-restart")
      const fromBranchId = BranchId.make("branch-switch-branch-restart-from")
      const toBranchId = BranchId.make("branch-switch-branch-restart-to")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId: fromBranchId,
          now: FIXED_NOW,
        })
        yield* branches.createBranch(
          new Branch({ id: toBranchId, sessionId, createdAt: FIXED_NOW }),
        )
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        yield* mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          requestId: "req-switch-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM branches WHERE id = ${fromBranchId}`
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        yield* mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          requestId: "req-switch-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      const session = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        return yield* sessions.getSession(sessionId)
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      expect(session?.activeBranchId).toBe(toBranchId)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("forkBranch requestId replays durable result after mutations layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionMutationsLayer(dbPath)
      const sessionId = SessionId.make("session-fork-branch-restart")
      const branchId = BranchId.make("branch-fork-branch-restart")
      const messageId = MessageId.make("message-fork-branch-restart")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })
        yield* messages.createMessage(
          Message.cases.regular.make({
            id: messageId,
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "seed" })],
            createdAt: FIXED_NOW,
          }),
        )
      }).pipe(Effect.provide(layer))

      const first = yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.forkSessionBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
          requestId: "req-fork-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM messages WHERE branch_id = ${branchId}`
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      const second = yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        return yield* mutations.forkSessionBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "retry fork should not allocate",
          requestId: "req-fork-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      const branches = yield* Effect.gen(function* () {
        const storage = yield* BranchStorage
        return yield* storage.listBranches(sessionId)
      }).pipe(Effect.provide(makePersistentSessionMutationsLayer(dbPath)))

      expect(second.branchId).toBe(first.branchId)
      expect(branches).toHaveLength(2)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )
})

// ── message send ────────────────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("message.send", () => {
  it.live(
    "persists the user message and assistant reply through the public snapshot contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "hello from acceptance"
          const assistantText = "acceptance reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "assistant reply in session snapshot",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("a session created with a run spec runs its turns under it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "runSpec acceptance reply"
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("high")
            },
          },
        ])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({
          cwd: process.cwd(),
          admission: {
            runSpec: {
              overrides: {
                modelId: ModelId.make("custom/model"),
                reasoningEffort: "high",
                systemPromptAddendum: "Extra public contract instructions",
              },
            },
          },
        })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use run spec",
        })

        const snapshot = yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from runSpec turn",
        )

        expect(
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text === assistantText),
          ),
        ).toBe(true)
        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a create that names an unknown agent fails and stores nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const before = yield* client.session.list()
        const error = yield* client.session
          .create({ cwd: process.cwd(), admission: { agent: AgentName.make("revieww") } })
          .pipe(Effect.flip)
        expect(error._tag).toBe("NotFoundError")
        expect(error.message).toBe("Unknown agent: revieww")
        expect(yield* client.session.list()).toHaveLength(before.length)
        // A known agent still admits.
        const created = yield* client.session.create({
          cwd: process.cwd(),
          admission: { agent: AgentName.make("main") },
        })
        const stored = yield* client.session.get({ sessionId: created.sessionId })
        expect(stored?.admission?.agent).toBe(AgentName.make("main"))
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a create whose admission names nothing stores no admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd(), admission: {} })
        const stored = yield* client.session.get({ sessionId: created.sessionId })
        expect(stored?.admission).toBeUndefined()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("config agent overrides set the model and effort, and a runSpec still wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("configured reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("openai/gpt-5.6-sol")
              expect(request.reasoning).toBe("low")
            },
          },
          {
            ...textStep("run spec reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("low")
            },
          },
        ])
        const configServiceLayer = ConfigService.Test(
          new UserConfig({
            agents: {
              [AgentName.make("main")]: {
                modelId: ModelId.make("openai/gpt-5.6-sol"),
                reasoningEffort: "low",
              },
            },
          }),
        )
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer, configServiceLayer }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })
        const specified = yield* client.session.create({
          cwd: process.cwd(),
          admission: { runSpec: { overrides: { modelId: ModelId.make("custom/model") } } },
        })
        const replied = (session: typeof created, text: string) =>
          waitFor(
            client.session.getSnapshot({
              sessionId: session.sessionId,
              branchId: session.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === text),
              ),
            5_000,
            `assistant reply: ${text}`,
          )

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use the configured model",
        })
        yield* replied(created, "configured reply")

        yield* client.message.send({
          sessionId: specified.sessionId,
          branchId: specified.branchId,
          content: "use the run spec model",
        })
        yield* replied(specified, "run spec reply")
        yield* controls.assertDone
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live("a session's own model setting wins over the run spec it was created with", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionModel = ModelId.make("custom/session-model")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("session model reply"),
            assertRequest: (request) => {
              expect(request.model).toBe(sessionModel)
            },
          },
        ])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({
          cwd: process.cwd(),
          admission: { runSpec: { overrides: { modelId: ModelId.make("custom/model") } } },
        })
        const target = { sessionId: created.sessionId, branchId: created.branchId }
        const admitted = yield* client.session.getSnapshot(target)
        expect(admitted.agent).toBe(AgentName.make("main"))
        expect(admitted.resolvedModelId).toBe(ModelId.make("custom/model"))

        yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: Option.some(sessionModel),
          reasoningLevel: Option.none(),
        })
        expect((yield* client.session.getSnapshot(target)).resolvedModelId).toBe(sessionModel)
        yield* client.message.send({ ...target, content: "use the session model" })
        yield* waitFor(
          client.session.getSnapshot(target),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some(
                  (part) => part.type === "text" && part.text === "session model reply",
                ),
            ),
          5_000,
          "assistant reply on the session model",
        )
        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a settings change touches only the field it names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })
        const sessionModel = ModelId.make("custom/session-model")
        yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: Option.some(sessionModel),
          reasoningLevel: Option.some("high"),
        })
        // A change of effort alone keeps the stored model.
        const effort = yield* client.session.updateSettings({
          sessionId: created.sessionId,
          reasoningLevel: Option.some("low"),
        })
        expect(effort).toEqual({ modelId: sessionModel, reasoningLevel: "low" })
        // `None` clears one field and leaves the other.
        const cleared = yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: Option.none(),
        })
        expect(cleared).toEqual({ modelId: absentModel, reasoningLevel: "low" })
        const snapshot = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(snapshot.modelId).toBeUndefined()
        expect(snapshot.reasoningLevel).toBe("low")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("session settings win over config agent overrides until they are cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("session model reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/session-model")
              expect(request.reasoning).toBe("max")
            },
          },
          {
            ...textStep("configured reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("openai/gpt-5.6-sol")
              expect(request.reasoning).toBe("low")
            },
          },
        ])
        const configServiceLayer = ConfigService.Test(
          new UserConfig({
            agents: {
              [AgentName.make("main")]: {
                modelId: ModelId.make("openai/gpt-5.6-sol"),
                reasoningEffort: "low",
              },
            },
          }),
        )
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer, configServiceLayer }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })
        const replied = (text: string) =>
          waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === text),
              ),
            5_000,
            `assistant reply: ${text}`,
          )
        // Before any setting or turn, the snapshot already resolves the config default.
        const fresh = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(fresh.resolvedModelId).toBe(ModelId.make("openai/gpt-5.6-sol"))
        expect(fresh.resolvedReasoningLevel).toBe("low")

        const sessionModel = ModelId.make("custom/session-model")
        const stored = yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: Option.some(sessionModel),
          reasoningLevel: Option.some("max"),
        })
        expect(stored).toEqual({ modelId: sessionModel, reasoningLevel: "max" })
        const withSettings = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(withSettings.modelId).toBe(sessionModel)
        expect(withSettings.reasoningLevel).toBe("max")
        expect(withSettings.resolvedModelId).toBe(sessionModel)
        expect(withSettings.resolvedReasoningLevel).toBe("max")

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use the session model",
        })
        yield* replied("session model reply")

        yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: Option.none(),
          reasoningLevel: Option.none(),
        })
        // Cleared settings resolve back to the config default before the next turn.
        const cleared = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(cleared.resolvedModelId).toBe(ModelId.make("openai/gpt-5.6-sol"))
        expect(cleared.resolvedReasoningLevel).toBe("low")
        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "back to the configured model",
        })
        yield* replied("configured reply")
        yield* controls.assertDone
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live(
    "a model change leaves a durable notice the next turn reads; an effort change does not",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nextModel = ModelId.make("custom/next-model")
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            {
              ...textStep("before the switch"),
              assertOptions: (options) => {
                expect(encodeJson(options.prompt)).not.toContain("[model changed:")
              },
            },
            {
              ...textStep("after the switch"),
              assertOptions: (options) => {
                expect(encodeJson(options.prompt)).toContain(
                  `the session continues with ${nextModel}]`,
                )
              },
            },
            textStep("after the effort change"),
          ])
          const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
          const created = yield* client.session.create({ cwd: process.cwd() })
          const snapshot = () =>
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
          const notices = () =>
            snapshot().pipe(
              Effect.map((current) =>
                current.messages.filter(
                  (message) => message.metadata?.customType === "model-change",
                ),
              ),
            )
          const turn = (content: string, reply: string) =>
            Effect.gen(function* () {
              yield* client.message.send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content,
              })
              yield* waitFor(
                snapshot(),
                (current) =>
                  current.messages.some(
                    (message) =>
                      message.role === "assistant" &&
                      message.parts.some((part) => part.type === "text" && part.text === reply),
                  ),
                5_000,
                `assistant reply: ${reply}`,
              )
            })
          // A branch with no step yet has nothing to attribute: no notice.
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: Option.none(),
            reasoningLevel: Option.some("low"),
          })
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: Option.none(),
            reasoningLevel: Option.some("low"),
          })
          yield* turn("first", "before the switch")
          expect(yield* notices()).toHaveLength(0)
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: Option.some(nextModel),
            reasoningLevel: Option.some("low"),
          })
          // The settings write records the choice; the loop writes the line.
          expect(yield* notices()).toHaveLength(0)
          yield* turn("hello", "after the switch")
          const [notice] = yield* notices()
          expect(notice?.role).toBe("user")
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: Option.some(nextModel),
            reasoningLevel: Option.some("max"),
          })
          yield* turn("again", "after the effort change")
          expect(yield* notices()).toHaveLength(1)
          yield* controls.assertDone
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live("rejects a deleted session before provider dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("should not run"),
        ])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })

        const exit = yield* Effect.exit(
          client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "deleted session",
          }),
        )

        expect(exit._tag).toBe("Failure")
        expect(yield* controls.callCount).toBe(0)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── session snapshot rpc ────────────────────────────────────────────────────

/**
 * Session snapshot canary: exercises product RPCs over fresh request scopes.
 */

describe("Session snapshot across RPC boundaries", () => {
  it.live(
    "session snapshot observes messages across RPC request boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))

          const { sessionId, branchId } = yield* client.session.create({})

          const before = yield* client.session.getSnapshot({ sessionId, branchId })
          yield* client.message.send({ sessionId, branchId, content: "hello" })
          const after = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) =>
              snapshot.messages.some((message) => messagePartsText(message.parts) === "hello") &&
              snapshot.metrics.turns > 0,
            5_000,
            "session snapshot user message and metrics",
          )

          expect(after.messages.length).toBeGreaterThanOrEqual(before.messages.length)
          expect(after.messages.map((message) => messagePartsText(message.parts))).toContain(
            "hello",
          )
          expect(after.metrics.turns).toBeGreaterThan(0)
          expect(after.metrics.lastInputTokens).toBeGreaterThan(0)
          expect(after.resolvedModelId).toBeDefined()
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
