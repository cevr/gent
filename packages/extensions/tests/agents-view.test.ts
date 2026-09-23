import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Fiber, Option, Predicate, Queue, Ref, Schema, Stream } from "effect"
import { BranchId, ExtensionContext, ref, SessionId, ToolCallId } from "@gent/core/extensions/api"
import { AgentEvent } from "@gent/core/protocol"
import {
  activityText,
  AgentActivity,
  AgentActivityLive,
  type AgentRow,
  AgentsViewExtension,
  AgentsViewRpc,
  buildRowTree,
  type DurableAgentRow,
  emptyActivity,
  filterRows,
  foldActivity,
  type LiveAgentRow,
  projectAgentRows,
  propagateRunning,
  reconcileAgentRows,
  rowKey,
  sectionOf,
} from "../src/agents-view.js"
import {
  LanguageModelLayers,
  textStep,
  createRpcHarness,
  testLeafContext,
  testToolContext,
  waitFor,
} from "@gent/core/test-utils"
import { e2ePreset } from "./helpers/test-preset"

// ── agents-view/projection.test ─────────────────────────────────────────────

const sid = (value: string) => SessionId.make(value)
const bid = (value: string) => BranchId.make(value)

const live = (overrides: { session: string; branch: string; status?: string }): LiveAgentRow => ({
  sessionId: sid(overrides.session),
  branchId: bid(overrides.branch),
  status: Option.some(overrides.status ?? "Running"),
})

const durable = (overrides: {
  session: string
  branch: string
  name?: string
  cwd?: string
  parentSession?: string
  parentBranch?: string
  updatedAt?: number
  sideThread?: boolean
}): DurableAgentRow => ({
  sessionId: sid(overrides.session),
  branchId: bid(overrides.branch),
  name: Option.fromUndefinedOr(overrides.name),
  cwd: Option.fromUndefinedOr(overrides.cwd),
  parent: Option.all([
    Option.fromUndefinedOr(overrides.parentSession),
    Option.fromUndefinedOr(overrides.parentBranch),
  ]).pipe(
    Option.map(([parentSession, parentBranch]) => ({
      sessionId: sid(parentSession),
      branchId: bid(parentBranch),
    })),
  ),
  createdAt: 0,
  updatedAt: overrides.updatedAt ?? 0,
  sideThread: overrides.sideThread ?? false,
})

const find = (rows: ReadonlyArray<AgentRow>, session: string, branch: string) =>
  rows.find((row) => row.sessionId === sid(session) && row.branchId === bid(branch))

describe("agents view projection", () => {
  describe("row identity", () => {
    test("keys on session and branch together, so branches of one session are distinct rows", () => {
      const a = rowKey({ sessionId: sid("s1"), branchId: bid("b1") })
      const b = rowKey({ sessionId: sid("s1"), branchId: bid("b2") })
      expect(a).not.toBe(b)
    })

    test("a session and branch that concatenate alike still key apart", () => {
      const a = rowKey({ sessionId: sid("s"), branchId: bid("1 b") })
      const b = rowKey({ sessionId: sid("s 1"), branchId: bid("b") })
      expect(a).not.toBe(b)
    })
  })

  describe("sections", () => {
    test("a materialized running loop is running", () => {
      const row = live({ session: "s", branch: "b", status: "Running" })
      expect(sectionOf(Option.some(row))).toBe("running")
    })

    test("a materialized idle loop is idle", () => {
      const row = live({ session: "s", branch: "b", status: "Idle" })
      expect(sectionOf(Option.some(row))).toBe("idle")
    })

    test("a loop waiting on an interaction counts as running, not idle", () => {
      const row = live({ session: "s", branch: "b", status: "WaitingForInteraction" })
      expect(sectionOf(Option.some(row))).toBe("running")
    })

    test("a durable-only row is inactive", () => {
      expect(sectionOf(Option.none())).toBe("inactive")
    })

    test("a resident loop with an unread status is idle, not running", () => {
      // Being materialized is not the same as working. Reporting it as running
      // would strand every live loop in `running` and make `idle` unreachable.
      const row = { ...live({ session: "s", branch: "b" }), status: Option.none() }
      expect(sectionOf(Option.some(row))).toBe("idle")
    })
  })

  describe("reconciliation", () => {
    test("merges a live and durable row for the same loop into one row", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1", status: "Running" })],
        durable: [durable({ session: "s1", branch: "b1", name: "my task", cwd: "/repo" })],
      })
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.live).toBe(true)
      expect(row?.section).toBe("running")
      // Live supplies status; durable supplies the fields the registry lacks.
      expect(row?.name).toEqual(Option.some("my task"))
      expect(row?.cwd).toEqual(Option.some("/repo"))
    })

    test("keeps a live loop that has no durable row yet", () => {
      // A brand-new loop must not be invisible until its session row is written.
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" })],
        durable: [],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.live).toBe(true)
    })

    test("keeps a durable row with no live loop, as inactive", () => {
      // This is the after-restart case: the registry is empty, storage is not.
      const rows = reconcileAgentRows({
        live: [],
        durable: [durable({ session: "s1", branch: "b1", name: "yesterday" })],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.live).toBe(false)
      expect(rows[0]?.section).toBe("inactive")
      expect(rows[0]?.name).toEqual(Option.some("yesterday"))
    })

    test("does not collapse two branches of one session", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" }), live({ session: "s1", branch: "b2" })],
        durable: [],
      })
      expect(rows).toHaveLength(2)
    })

    test("carries durable name and cwd through", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" })],
        durable: [durable({ session: "s1", branch: "b1", name: "Fix the parser", cwd: "/repo" })],
      })
      expect(rows[0]?.name).toEqual(Option.some("Fix the parser"))
      expect(rows[0]?.cwd).toEqual(Option.some("/repo"))
    })
  })

  describe("tree building", () => {
    test("nests a child under its parent", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "parent", branch: "b1" }),
            durable({
              session: "child",
              branch: "b1",
              parentSession: "parent",
              parentBranch: "b1",
            }),
          ],
        }),
      )
      expect(find(rows, "parent", "b1")?.depth).toBe(0)
      expect(find(rows, "child", "b1")?.depth).toBe(1)
    })

    test("nests a grandchild two deep", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "a", branch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
            durable({ session: "c", branch: "b", parentSession: "b", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "c", "b")?.depth).toBe(2)
    })

    test("promotes an orphan to top level rather than hiding it", () => {
      // The parent has not loaded. Dropping the child would make real work vanish.
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({
              session: "orphan",
              branch: "b1",
              parentSession: "missing",
              parentBranch: "b1",
            }),
          ],
        }),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.depth).toBe(0)
    })

    test("terminates on a parent cycle instead of looping forever", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "a", branch: "b", parentSession: "b", parentBranch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
          ],
        }),
      )
      expect(rows).toHaveLength(2)
    })

    test("orders running before idle before inactive", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [
            live({ session: "idle", branch: "b", status: "Idle" }),
            live({ session: "run", branch: "b", status: "Running" }),
          ],
          durable: [durable({ session: "old", branch: "b" })],
        }),
      )
      expect(rows.map((row) => row.section)).toEqual(["running", "idle", "inactive"])
    })

    test("orders more recent rows first within a section", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "older", branch: "b", updatedAt: 100 }),
            durable({ session: "newer", branch: "b", updatedAt: 200 }),
          ],
        }),
      )
      expect(rows[0]?.sessionId).toBe(sid("newer"))
    })
  })

  describe("running propagation", () => {
    test("forces an idle parent to running while a child runs", () => {
      // A collapsed parent must not look idle while its subagent works.
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "parent", branch: "b", status: "Idle" }),
            live({ session: "child", branch: "b", status: "Running" }),
          ],
          durable: [
            durable({ session: "parent", branch: "b" }),
            durable({ session: "child", branch: "b", parentSession: "parent", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "parent", "b")?.section).toBe("running")
    })

    test("propagates through two levels to the grandparent", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "a", branch: "b", status: "Idle" }),
            live({ session: "b", branch: "b", status: "Idle" }),
            live({ session: "c", branch: "b", status: "Running" }),
          ],
          durable: [
            durable({ session: "a", branch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
            durable({ session: "c", branch: "b", parentSession: "b", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "a", "b")?.section).toBe("running")
    })

    test("leaves an idle parent idle when no descendant runs", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "parent", branch: "b", status: "Idle" }),
            live({ session: "child", branch: "b", status: "Idle" }),
          ],
          durable: [
            durable({ session: "parent", branch: "b" }),
            durable({ session: "child", branch: "b", parentSession: "parent", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "parent", "b")?.section).toBe("idle")
    })

    test("terminates on a cycle", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [live({ session: "a", branch: "b", status: "Running" })],
          durable: [
            durable({ session: "a", branch: "b", parentSession: "b", parentBranch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
          ],
        }),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe("search", () => {
    const rows = buildRowTree(
      reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" })],
        durable: [durable({ session: "s1", branch: "b1", name: "Fix the parser", cwd: "/repo" })],
      }),
    )

    test("returns everything for an empty query", () => {
      expect(filterRows(rows, "")).toHaveLength(1)
      expect(filterRows(rows, "   ")).toHaveLength(1)
    })

    test("matches on name, case-insensitively", () => {
      expect(filterRows(rows, "PARSER")).toHaveLength(1)
    })

    test("matches on cwd and ids", () => {
      expect(filterRows(rows, "/repo")).toHaveLength(1)
      expect(filterRows(rows, "s1")).toHaveLength(1)
    })

    test("returns nothing for a miss", () => {
      expect(filterRows(rows, "nonexistent")).toHaveLength(0)
    })
  })

  describe("full projection", () => {
    test("reconciles, propagates, and orders in one pass", () => {
      const rows = projectAgentRows({
        live: [
          live({ session: "parent", branch: "b", status: "Idle" }),
          live({ session: "child", branch: "b", status: "Running" }),
        ],
        durable: [
          durable({ session: "parent", branch: "b", name: "parent task", updatedAt: 200 }),
          durable({
            session: "child",
            branch: "b",
            name: "child task",
            updatedAt: 100,
            parentSession: "parent",
            parentBranch: "b",
          }),
          durable({ session: "gone", branch: "b", name: "old task", updatedAt: 50 }),
        ],
      })
      expect(rows).toHaveLength(3)
      // The idle parent was forced running by its child, so both sort first.
      expect(rows[0]?.section).toBe("running")
      expect(rows[1]?.section).toBe("running")
      expect(rows[2]?.section).toBe("inactive")
      expect(find(rows, "child", "b")?.depth).toBe(1)
    })

    test("survives an empty live catalog, as after a restart", () => {
      const rows = projectAgentRows({
        live: [],
        durable: [durable({ session: "s1", branch: "b1", name: "yesterday" })],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.section).toBe("inactive")
    })

    test("returns nothing when both catalogs are empty", () => {
      expect(projectAgentRows({ live: [], durable: [] })).toHaveLength(0)
    })
  })
})

// ── agents-view/agents-view-rpc.test ────────────────────────────────────────

// ── agents-view/activity.test ───────────────────────────────────────────────

describe("agents view live activity", () => {
  const sessionId = sid("activity-session")
  const branchId = bid("activity-branch")
  const fold = (events: ReadonlyArray<AgentEvent>) => events.reduce(foldActivity, emptyActivity)
  const started = (id: string, toolName: string) =>
    AgentEvent.cases.ToolCallStarted.make({
      sessionId,
      branchId,
      toolCallId: ToolCallId.make(id),
      toolName,
    })
  const chunk = (text: string) =>
    AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: text })

  test("a streamed reply shows its last line", () => {
    const state = fold([chunk("Reading the loader.\nChecking"), chunk(" the tests")])
    expect(Option.getOrUndefined(activityText(state))).toBe("Checking the tests")
  })

  test("a running tool wins over the text, and the newest running tool is named", () => {
    const state = fold([chunk("thinking"), started("tc-cell", "cell"), started("tc-bash", "bash")])
    expect(Option.getOrUndefined(activityText(state))).toBe("running bash")
    const afterBash = foldActivity(
      state,
      AgentEvent.cases.ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: ToolCallId.make("tc-bash"),
        toolName: "bash",
      }),
    )
    expect(Option.getOrUndefined(activityText(afterBash))).toBe("running cell")
  })

  test("a completed turn reports nothing", () => {
    const state = fold([
      chunk("done"),
      started("tc-read", "read"),
      AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
    ])
    expect(Option.isNone(activityText(state))).toBe(true)
  })
})

/**
 * Agents view RPC acceptance — exercises AgentsViewExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 *
 * The projection itself is covered by pure tests in `projection.test.ts`. What
 * this file adds is the wiring: that `listSessions` and `listActiveLoops` reach
 * real host facets rather than their `unavailable` defaults. Both facets die
 * when unwired, so a passing assertion here is proof the seam is connected.
 */

const ReplySchema = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      branchId: Schema.String,
      section: Schema.String,
      status: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      live: Schema.Boolean,
      depth: Schema.Finite,
      parentSessionId: Schema.optional(Schema.String),
      sideThread: Schema.Boolean,
      activity: Schema.optional(Schema.String),
    }),
  ),
})

const openHarness = Effect.gen(function* () {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
  return yield* createRpcHarness({
    ...e2ePreset,
    providerLayer,
    extensionInputs: [AgentsViewExtension],
    cwd: "/tmp/agents-view-rpc",
  })
})

type Harness = Effect.Success<typeof openHarness>

const requestRows = (harness: Harness, input: { readonly query?: string }) =>
  Effect.gen(function* () {
    const raw = yield* harness.client.extension.request({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
      extensionId: ref(AgentsViewRpc.ListAgents).extensionId,
      capabilityId: ref(AgentsViewRpc.ListAgents).capabilityId,
      input,
    })
    const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)
    return { raw, reply }
  })

const listAgents = (input: { readonly query?: string }) =>
  Effect.gen(function* () {
    const harness = yield* openHarness
    const { raw, reply } = yield* requestRows(harness, input)
    return { raw, reply, harness, sessionId: harness.sessionId, branchId: harness.branchId }
  })

/**
 * One loop behind a scripted `Session`: `events` reads a queue the test feeds,
 * and `listActiveLoops` reports the loop with `status`, or not at all once it
 * is `None`. `checks` counts the listing reads: one per follow, one per
 * follower start and one per turn end, so a test sees whether a follower
 * still runs.
 */
const scriptedLoop = Effect.gen(function* () {
  const loop = { sessionId: sid("child-session"), branchId: bid("child-branch") }
  const events = yield* Queue.unbounded<AgentEvent>()
  const status = yield* Ref.make<Option.Option<string>>(Option.some("Running"))
  const checks = yield* Ref.make(0)
  const base = testToolContext()
  const ctx = testLeafContext(
    testToolContext({
      Session: {
        ...base.Session,
        events: () => Stream.fromQueue(events),
        listActiveLoops: Ref.update(checks, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(status)),
          Effect.map((current) =>
            Option.toArray(
              Option.map(current, (value) => ({ ...loop, status: Option.some(value) })),
            ),
          ),
        ),
      },
    }),
  )
  const activity = yield* AgentActivity
  const follow = activity.follow([loop]).pipe(Effect.provideService(ExtensionContext, ctx))
  const chunk = (text: string) =>
    Queue.offer(events, AgentEvent.cases.StreamChunk.make({ ...loop, chunk: text }))
  const turnCompleted = Queue.offer(
    events,
    AgentEvent.cases.TurnCompleted.make({ ...loop, durationMs: 1 }),
  )
  return { loop, status, checks, ctx, activity, follow, chunk, turnCompleted }
})

describe("AgentActivity followers", () => {
  it.live(
    "a follower for a loop that is not working ends at once",
    () =>
      Effect.gen(function* () {
        const script = yield* scriptedLoop
        yield* Ref.set(script.status, Option.some("Idle"))
        // Each follow starts a follower only when none runs, so the liveness
        // reads climb only while every follower has already ended.
        yield* waitFor(
          script.follow.pipe(Effect.andThen(Ref.get(script.checks))),
          (checks) => checks >= 3,
          2_000,
          "a new follower on each follow",
        )
        yield* script.chunk("never read")
        expect(Option.isNone(yield* script.activity.read(script.loop))).toBe(true)
      }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
    6_000,
  )

  it.live(
    "a follower ends at the turn end that leaves its loop idle, and a later turn gets a new one",
    () =>
      Effect.gen(function* () {
        const script = yield* scriptedLoop
        yield* script.follow
        yield* script.chunk("Reading the loader.")
        yield* waitFor(script.activity.read(script.loop), Option.isSome, 2_000, "the streamed line")
        // Still working at a turn's end (a queued follow-up): the follower stays.
        const beforeWorkingEnd = yield* Ref.get(script.checks)
        yield* script.turnCompleted
        yield* waitFor(
          Ref.get(script.checks),
          (checks) => checks > beforeWorkingEnd,
          2_000,
          "turn end check",
        )
        yield* script.chunk("Checking the tests.")
        const next = yield* waitFor(
          script.activity.read(script.loop),
          Option.isSome,
          2_000,
          "the next turn's line",
        )
        expect(Option.getOrUndefined(next)).toBe("Checking the tests.")
        // Idle at a turn's end: the child finished, and its follower ends.
        yield* Ref.set(script.status, Option.some("Idle"))
        const beforeIdleEnd = yield* Ref.get(script.checks)
        yield* script.turnCompleted
        yield* waitFor(
          Ref.get(script.checks),
          (checks) => checks > beforeIdleEnd,
          2_000,
          "idle turn end check",
        )
        expect(Option.isNone(yield* script.activity.read(script.loop))).toBe(true)
        // A later turn: the follow reads the listing once, and a new follower
        // reads it again as it starts. A follower still running would block
        // the new one, and only the listing read would count.
        yield* Ref.set(script.status, Option.some("Running"))
        const beforeFollow = yield* Ref.get(script.checks)
        yield* script.follow
        yield* waitFor(
          Ref.get(script.checks),
          (checks) => checks >= beforeFollow + 2,
          2_000,
          "a new follower for the later turn",
        )
      }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
    6_000,
  )

  const leftStatuses: ReadonlyArray<readonly [string, Option.Option<string>]> = [
    ["lists idle", Option.some("Idle")],
    ["no longer lists", Option.none()],
  ]
  for (const [label, status] of leftStatuses) {
    it.live(
      `a follow stops the follower of a loop the runtime ${label}`,
      () =>
        Effect.gen(function* () {
          const script = yield* scriptedLoop
          yield* script.follow
          yield* script.chunk("Reading the loader.")
          yield* waitFor(
            script.activity.read(script.loop),
            Option.isSome,
            2_000,
            "the streamed line",
          )
          // No turn end reads the change: only the next listing can stop it.
          yield* Ref.set(script.status, status)
          yield* script.activity
            .follow([])
            .pipe(Effect.provideService(ExtensionContext, script.ctx))
          expect(Option.isNone(yield* script.activity.read(script.loop))).toBe(true)
        }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
      6_000,
    )
  }
})

describe("AgentsViewExtension via RPC", () => {
  it.live(
    "the harness session appears as a row with its stored cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply, sessionId } = yield* listAgents({})

          // Proves `listSessions` is wired: an unwired facet dies instead.
          const row = reply.rows.find((candidate) => candidate.sessionId === sessionId)
          expect(row).toBeDefined()
          expect(row!.cwd).toBe("/tmp/agents-view-rpc")
          // No parent link, so the session sits at the root of the tree.
          expect(row!.depth).toBe(0)
          // The request ran on this session's loop, so the loop is resident and
          // the listing read its state rather than guessing.
          expect(row!.live).toBe(true)
          expect(row!.status).toBe("Idle")
          expect(row!.section).toBe("idle")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a live row names no agent, because the loop enumeration carries none",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { raw, sessionId } = yield* listAgents({})
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
          )(raw)
          const row = rows.rows.find((candidate) => candidate["sessionId"] === sessionId)
          expect(row?.["live"]).toBe(true)
          expect(Object.keys(row ?? {})).not.toContain("agent")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a running child reports its streamed line, and the line clears when its turn ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(
            "Reading the loader. Checking the tests.",
          )
          // The shipped extensions, the agents among them, so the turn runs.
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd: "/tmp/agents-view-rpc-activity",
          })
          const child = yield* harness.client.session.create({
            cwd: "/tmp/agents-view-rpc-activity",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })
          yield* harness.client.message.send({
            sessionId: child.sessionId,
            branchId: child.branchId,
            content: "look at the loader",
          })
          yield* controls.waitForStreamStart
          const rowOf = (reply: typeof ReplySchema.Type, sessionId: string) =>
            reply.rows.find((row) => row.sessionId === sessionId)
          // The tray has listed the child once, so its follower is open before
          // the line streams: it starts from now, not from the history.
          yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "running",
            5_000,
            "child running",
          )
          yield* controls.emitNext
          const busy = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.activity === "Reading the loader.",
            5_000,
            "streamed line in the child row",
          )
          // The root is not in the tray, so it is not followed.
          expect(rowOf(busy.reply, harness.sessionId)?.activity).toBeUndefined()
          yield* controls.emitAll
          const idle = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "idle",
            5_000,
            "child idle",
          )
          expect(rowOf(idle.reply, child.sessionId)?.activity).toBeUndefined()
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a filtered listing keeps the activity of the children it hides",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(
            "Reading the loader. Checking the tests.",
          )
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd: "/tmp/agents-view-rpc-filter",
          })
          const child = yield* harness.client.session.create({
            cwd: "/tmp/agents-view-rpc-filter",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })
          yield* harness.client.message.send({
            sessionId: child.sessionId,
            branchId: child.branchId,
            content: "look at the loader",
          })
          yield* controls.waitForStreamStart
          const rowOf = (reply: typeof ReplySchema.Type, sessionId: string) =>
            reply.rows.find((row) => row.sessionId === sessionId)
          // Only listings that hide the child, as a pane query that matches the
          // root alone sends. The busy child forces its root into `running`.
          const rootOnly = { query: String(harness.sessionId) }
          const rootRunning = yield* waitFor(
            requestRows(harness, rootOnly),
            ({ reply }) => rowOf(reply, harness.sessionId)?.section === "running",
            5_000,
            "root running under its child",
          )
          expect(rowOf(rootRunning.reply, child.sessionId)).toBeUndefined()
          const chunkPublished = yield* harness.client.session
            .events({ sessionId: child.sessionId, branchId: child.branchId })
            .pipe(
              Stream.filter((envelope) => envelope.event._tag === "StreamChunk"),
              Stream.runHead,
              Effect.forkScoped,
            )
          yield* controls.emitNext
          // The line is on the branch before the tray first reads without a
          // query: a follower started only now would never see it.
          yield* Fiber.join(chunkPublished)
          // The hidden child was followed all along, so the tray's first
          // unfiltered read sees the line it streamed.
          const shown = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => Predicate.isNotUndefined(rowOf(reply, child.sessionId)?.activity),
            3_000,
            "activity of the hidden child",
          ).pipe(Effect.option)
          expect(
            Option.getOrUndefined(
              Option.map(shown, ({ reply }) => rowOf(reply, child.sessionId)?.activity),
            ),
          ).toBe("Reading the loader.")
          // A query that hides every row leaves the follower in place.
          const filtered = yield* requestRows(harness, { query: "no-such-agent-anywhere" })
          expect(filtered.reply.rows).toHaveLength(0)
          const after = yield* requestRows(harness, {})
          expect(rowOf(after.reply, child.sessionId)?.activity).toBe("Reading the loader.")
          yield* controls.emitAll
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a finished child's follower stops, and its next turn reports from the listing that sees it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(
            "Reading the loader. Checking the tests.",
          )
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd: "/tmp/agents-view-rpc-turns",
          })
          const child = yield* harness.client.session.create({
            cwd: "/tmp/agents-view-rpc-turns",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })
          const rowOf = (reply: typeof ReplySchema.Type, sessionId: string) =>
            reply.rows.find((row) => row.sessionId === sessionId)
          // The first chunk of the second turn: every event after turn one ends.
          const secondTurnChunk = yield* harness.client.session
            .events({ sessionId: child.sessionId, branchId: child.branchId })
            .pipe(
              Stream.dropWhile((envelope) => envelope.event._tag !== "TurnCompleted"),
              Stream.filter((envelope) => envelope.event._tag === "StreamChunk"),
              Stream.runHead,
              Effect.forkScoped,
            )
          yield* harness.client.message.send({
            sessionId: child.sessionId,
            branchId: child.branchId,
            content: "look at the loader",
          })
          yield* controls.waitForStreamStart
          // Turn one: the tray lists the running child, which opens its follower.
          yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "running",
            5_000,
            "child running",
          )
          yield* controls.emitAll
          const idle = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "idle",
            5_000,
            "child idle",
          )
          // The turn's end clears the line.
          expect(rowOf(idle.reply, child.sessionId)?.activity).toBeUndefined()
          // Turn two streams its first line before any listing sees it running.
          // The listing that saw the child idle ended its follower, so no
          // follower reads that line.
          yield* harness.client.message.send({
            sessionId: child.sessionId,
            branchId: child.branchId,
            content: "now the tests",
          })
          yield* controls.emitNext
          yield* Fiber.join(secondTurnChunk)
          const running = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "running",
            5_000,
            "child running again",
          )
          expect(rowOf(running.reply, child.sessionId)?.activity).toBeUndefined()
          // That listing started a new follower, which reads the next line.
          yield* controls.emitNext
          const shown = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => Predicate.isNotUndefined(rowOf(reply, child.sessionId)?.activity),
            3_000,
            "second turn activity",
          )
          expect(rowOf(shown.reply, child.sessionId)?.activity).toBe("Checking the tests.")
          yield* controls.emitAll
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a query that matches nothing returns no rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply } = yield* listAgents({ query: "no-such-agent-anywhere" })
          expect(reply.rows).toHaveLength(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a child session nests under its parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* openHarness

          // `session.create` stores parentSessionId/parentBranchId, which is the
          // same link `delegate` writes for a subagent. Step 5's disclosure tree
          // reads nothing else, so proving depth here proves the nesting seam.
          const child = yield* harness.client.session.create({
            cwd: "/tmp/agents-view-rpc-child",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })

          const raw = yield* harness.client.extension.request({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
            extensionId: ref(AgentsViewRpc.ListAgents).extensionId,
            capabilityId: ref(AgentsViewRpc.ListAgents).capabilityId,
            input: {},
          })
          const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)

          const parentRow = reply.rows.find((row) => row.sessionId === harness.sessionId)
          const childRow = reply.rows.find((row) => row.sessionId === child.sessionId)
          expect(parentRow?.depth).toBe(0)
          expect(childRow?.depth).toBe(1)
          // The tray counts a session's subtree client-side, so the link travels.
          expect(parentRow?.parentSessionId).toBeUndefined()
          expect(childRow?.parentSessionId).toBe(harness.sessionId)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a stored child with no loop is listed, and only a spawned one is a side thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* openHarness
          const parent = { parentSessionId: harness.sessionId, parentBranchId: harness.branchId }
          // A delegate child or a `/btw` fork opens a thread of its own.
          const spawned = yield* harness.client.session.create({ cwd: "/tmp/spawned", ...parent })
          // A handoff continues the parent's thread.
          const handoff = yield* harness.client.session.create({
            cwd: "/tmp/handoff",
            continueThread: true,
            ...parent,
          })

          // A child may name only its parent session.
          const sessionOnly = yield* harness.client.session.create({
            cwd: "/tmp/session-only",
            parentSessionId: harness.sessionId,
          })

          const { reply } = yield* requestRows(harness, {})
          const rowFor = (sessionId: string) =>
            reply.rows.find((row) => row.sessionId === sessionId)
          const spawnedRow = rowFor(spawned.sessionId)
          const handoffRow = rowFor(handoff.sessionId)
          // Neither child ever ran, so no loop exists: the rows come from storage.
          expect(spawnedRow?.live).toBe(false)
          expect(spawnedRow?.section).toBe("inactive")
          expect(handoffRow?.live).toBe(false)
          expect(spawnedRow?.sideThread).toBe(true)
          expect(rowFor(sessionOnly.sessionId)?.sideThread).toBe(true)
          expect(handoffRow?.sideThread).toBe(false)
          expect(rowFor(harness.sessionId)?.sideThread).toBe(false)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "the search filter keeps the session it matches",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply, sessionId } = yield* listAgents({ query: "agents-view-rpc" })
          expect(reply.rows.map((row) => row.sessionId)).toContain(sessionId)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
