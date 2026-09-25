import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Effect, Fiber, Option, Predicate, Queue, Ref, Schema, Stream } from "effect"
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

// ── projection ──────────────────────────────────────────────────────────────

const sid = (value: string) => SessionId.make(value)
const bid = (value: string) => BranchId.make(value)

const live = (overrides: { session: string; branch: string; status?: string }): LiveAgentRow => ({
  sessionId: sid(overrides.session),
  branchId: bid(overrides.branch),
  status: Option.some(overrides.status ?? "Running"),
  runningSince: Option.none(),
})

const durable = (overrides: {
  session: string
  branch: string
  name?: string
  cwd?: string
  parentSession?: string
  parentBranch?: string
  createdAt?: number
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
  createdAt: overrides.createdAt ?? 0,
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

    test("a child whose parent sits in another section is a root of its own section", () => {
      // After a restart the parent's loop is back and idle while its child is
      // only stored. The child heads the inactive section; indented, it would
      // read as a child of whichever row sits above it.
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [live({ session: "parent", branch: "b", status: "Idle" })],
          durable: [
            durable({ session: "parent", branch: "b", updatedAt: 10 }),
            durable({ session: "unrelated", branch: "b", updatedAt: 30 }),
            durable({
              session: "child",
              branch: "b",
              parentSession: "parent",
              parentBranch: "b",
              updatedAt: 20,
            }),
          ],
        }),
      )
      expect(rows.map((row) => [row.sessionId, row.section, row.depth])).toEqual([
        [sid("parent"), "idle", 0],
        [sid("unrelated"), "inactive", 0],
        [sid("child"), "inactive", 0],
      ])
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

    test("draws children under their parent in the order they started, as the tray does", () => {
      const child = (session: string, createdAt: number, updatedAt: number) =>
        durable({
          session,
          branch: "b",
          parentSession: "parent",
          parentBranch: "b",
          createdAt,
          updatedAt,
        })
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            // The newest update first, as a listing returns them.
            child("gamma", 300, 900),
            child("beta", 200, 800),
            child("alpha", 100, 700),
            durable({ session: "parent", branch: "b", createdAt: 50, updatedAt: 600 }),
            durable({ session: "other", branch: "b", createdAt: 10, updatedAt: 650 }),
          ],
        }),
      )
      expect(rows.map((row) => row.sessionId)).toEqual(
        ["other", "parent", "alpha", "beta", "gamma"].map(sid),
      )
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

  describe("sections by own state", () => {
    test("an idle middle parent sits in the idle section while its grandchild runs", () => {
      // main → a → b. a started b and its own turn ended; only b works.
      const rows = projectAgentRows({
        live: [
          live({ session: "main", branch: "b", status: "Idle" }),
          live({ session: "a", branch: "b", status: "Idle" }),
          live({ session: "b", branch: "b", status: "Running" }),
        ],
        durable: [
          durable({ session: "main", branch: "b" }),
          durable({ session: "a", branch: "b", parentSession: "main", parentBranch: "b" }),
          durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
        ],
      })
      expect(rows.map((row) => [row.sessionId, row.section, row.depth])).toEqual([
        [sid("b"), "running", 0],
        [sid("main"), "idle", 0],
        [sid("a"), "idle", 1],
      ])
    })

    test("a parent cycle still lists every row", () => {
      const rows = projectAgentRows({
        live: [live({ session: "a", branch: "b", status: "Running" })],
        durable: [
          durable({ session: "a", branch: "b", parentSession: "b", parentBranch: "b" }),
          durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
        ],
      })
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
    test("reconciles and orders in one pass", () => {
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
      // Each row sits in its own state's section: the working child first, as
      // a root there, then its idle parent, then the stored row.
      expect(rows.map((row) => [row.sessionId, row.section, row.depth])).toEqual([
        [sid("child"), "running", 0],
        [sid("parent"), "idle", 0],
        [sid("gone"), "inactive", 0],
      ])
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

// ── live activity ───────────────────────────────────────────────────────────

describe("agents view live activity", () => {
  const sessionId = sid("activity-session")
  const branchId = bid("activity-branch")
  const fold = (events: ReadonlyArray<AgentEvent>) => events.reduce(foldActivity, emptyActivity)
  const started = (id: string, toolName: string, input: Readonly<Record<string, string>> = {}) =>
    AgentEvent.cases.ToolCallStarted.make({
      sessionId,
      branchId,
      toolCallId: ToolCallId.make(id),
      toolName,
      input,
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

  test("a running tool names the first line of the command, path or pattern it works on", () => {
    const bash = fold([
      started("tc-bash", "bash", { command: "  bun test tests/money.test.ts\necho done" }),
    ])
    expect(Option.getOrUndefined(activityText(bash))).toBe(
      "running bash bun test tests/money.test.ts",
    )
    const read = fold([started("tc-read", "read", { path: "src/loader.ts" })])
    expect(Option.getOrUndefined(activityText(read))).toBe("running read src/loader.ts")
    const long = fold([started("tc-long", "bash", { command: "x".repeat(200) })])
    expect([...(Option.getOrUndefined(activityText(long)) ?? "")].length).toBe(80)
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
      createdAt: Schema.optional(Schema.Finite),
      runningSince: Schema.optional(Schema.Finite),
    }),
  ),
})

const openHarness = Effect.gen(function* () {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
  return yield* createRpcHarness({
    ...e2ePreset,
    providerLayer,
    extensionInputs: [AgentsViewExtension],
    cwd: "/nonexistent/agents-view-rpc",
  })
})

type Harness = Effect.Success<typeof openHarness>

const requestRows = (
  harness: Harness,
  input: { readonly query?: string; readonly root?: string },
) =>
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
 * and the runtime lists the loop with `status`, or not at all once it is
 * `None`. `followWith` reads that listing once and hands it to `follow`, as a
 * listing request does.
 */
const scriptedLoop = Effect.gen(function* () {
  const loop = { sessionId: sid("child-session"), branchId: bid("child-branch") }
  const events = yield* Queue.unbounded<AgentEvent>()
  const status = yield* Ref.make<Option.Option<string>>(Option.some("Running"))
  const base = testToolContext()
  const ctx = testLeafContext(
    testToolContext({
      Session: { ...base.Session, events: () => Stream.fromQueue(events) },
    }),
  )
  const activity = yield* AgentActivity
  const followWith = (watch: ReadonlyArray<typeof loop>) =>
    Ref.get(status).pipe(
      Effect.flatMap((current) =>
        activity.follow({ listed: Option.toArray(Option.as(current, loop)), watch }),
      ),
      Effect.provideService(ExtensionContext, ctx),
    )
  const follow = followWith([loop])
  const chunk = (text: string) =>
    Queue.offer(events, AgentEvent.cases.StreamChunk.make({ ...loop, chunk: text }))
  const turnCompleted = Queue.offer(
    events,
    AgentEvent.cases.TurnCompleted.make({ ...loop, durationMs: 1 }),
  )
  return { loop, status, activity, follow, followWith, chunk, turnCompleted }
})

describe("AgentActivity watchers", () => {
  it.live(
    "a watcher keeps its loop across an idle turn end: the line clears, and the next turn shows at once",
    () =>
      Effect.gen(function* () {
        const script = yield* scriptedLoop
        yield* script.follow
        yield* script.chunk("Reading the loader.")
        yield* waitFor(script.activity.read(script.loop), Option.isSome, 2_000, "the streamed line")
        // The child finishes its turn and settles idle.
        yield* Ref.set(script.status, Option.some("Idle"))
        yield* script.turnCompleted
        yield* waitFor(
          script.activity.read(script.loop),
          Option.isNone,
          2_000,
          "the line cleared at the turn end",
        )
        // A queued turn starts with no listing in between: its first line shows.
        yield* Ref.set(script.status, Option.some("Running"))
        yield* script.chunk("Checking the tests.")
        const next = yield* waitFor(
          script.activity.read(script.loop),
          Option.isSome,
          2_000,
          "the next turn's line",
        )
        expect(Option.getOrUndefined(next)).toBe("Checking the tests.")
      }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
    6_000,
  )

  it.live(
    "a follow keeps the watcher of a loop the runtime lists idle",
    () =>
      Effect.gen(function* () {
        const script = yield* scriptedLoop
        yield* script.follow
        yield* Ref.set(script.status, Option.some("Idle"))
        yield* script.followWith([])
        yield* script.chunk("Reading the loader.")
        yield* waitFor(
          script.activity.read(script.loop),
          Option.isSome,
          2_000,
          "the idle loop's next line",
        )
      }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
    6_000,
  )

  it.live(
    "a follow stops the watcher of a loop the runtime no longer lists",
    () =>
      Effect.gen(function* () {
        const script = yield* scriptedLoop
        yield* script.follow
        yield* script.chunk("Reading the loader.")
        yield* waitFor(script.activity.read(script.loop), Option.isSome, 2_000, "the streamed line")
        // No event reads the change: only the next listing can stop it.
        yield* Ref.set(script.status, Option.none())
        yield* script.followWith([])
        expect(Option.isNone(yield* script.activity.read(script.loop))).toBe(true)
      }).pipe(Effect.provide(AgentActivityLive), Effect.scoped, Effect.timeout("4 seconds")),
    6_000,
  )
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
          expect(row!.cwd).toBe("/nonexistent/agents-view-rpc")
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
            cwd: "/nonexistent/agents-view-rpc-activity",
          })
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-activity",
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
    "a child woken after it settled runs since its new turn began, not since it was created",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } =
            yield* LanguageModelLayers.signal("Done with the loader.")
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd: "/nonexistent/agents-view-rpc-woken",
          })
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-woken",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })
          const rowOf = (reply: typeof ReplySchema.Type) =>
            reply.rows.find((row) => row.sessionId === child.sessionId)
          const send = (content: string) =>
            harness.client.message.send({
              sessionId: child.sessionId,
              branchId: child.branchId,
              content,
            })
          // The first task runs and settles.
          yield* send("look at the loader")
          yield* controls.waitForStreamStart
          yield* controls.emitAll
          yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply)?.section === "idle",
            5_000,
            "child settled",
          )
          const wokenAt = yield* Clock.currentTimeMillis
          // A correction wakes it: a new turn, held open by the model gate.
          yield* send("also check the tests")
          const running = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply)?.section === "running",
            5_000,
            "child running again",
          )
          const row = rowOf(running.reply)
          expect(row?.createdAt ?? Number.POSITIVE_INFINITY).toBeLessThan(wokenAt)
          expect(row?.runningSince ?? 0).toBeGreaterThanOrEqual(wokenAt)
          yield* controls.emitAll
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
            cwd: "/nonexistent/agents-view-rpc-filter",
          })
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-filter",
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
          // root alone sends.
          const rootOnly = yield* requestRows(harness, { query: String(harness.sessionId) })
          expect(rowOf(rootOnly.reply, harness.sessionId)).toBeDefined()
          expect(rowOf(rootOnly.reply, child.sessionId)).toBeUndefined()
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
    "a child's next turn reports its first line with no listing between the turns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(
            "Reading the loader. Checking the tests.",
          )
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd: "/nonexistent/agents-view-rpc-turns",
          })
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-turns",
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
          // Turn one: the tray lists the running child.
          yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "running",
            5_000,
            "child running",
          )
          yield* controls.emitAll
          // The agents pane opens on the idle child: its one listing sees the
          // child idle, and no listing follows until turn two has streamed.
          yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => rowOf(reply, child.sessionId)?.section === "idle",
            5_000,
            "child idle",
          )
          // Turn two starts from the loop itself, and streams its first line.
          yield* harness.client.message.send({
            sessionId: child.sessionId,
            branchId: child.branchId,
            content: "now the tests",
          })
          yield* controls.emitNext
          yield* Fiber.join(secondTurnChunk)
          const shown = yield* waitFor(
            requestRows(harness, {}),
            ({ reply }) => Predicate.isNotUndefined(rowOf(reply, child.sessionId)?.activity),
            3_000,
            "second turn activity",
          )
          expect(rowOf(shown.reply, child.sessionId)?.activity).toBe("Reading the loader.")
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
          // Neither has a loop, so both sit in one section: a row nests only
          // under a parent drawn in its own section.
          const parent = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-parent",
          })
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-child",
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })

          const raw = yield* harness.client.extension.request({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
            extensionId: ref(AgentsViewRpc.ListAgents).extensionId,
            capabilityId: ref(AgentsViewRpc.ListAgents).capabilityId,
            input: {},
          })
          const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)

          const parentRow = reply.rows.find((row) => row.sessionId === parent.sessionId)
          const childRow = reply.rows.find((row) => row.sessionId === child.sessionId)
          expect(parentRow?.depth).toBe(0)
          expect(childRow?.depth).toBe(1)
          // The tray counts a session's subtree client-side, so the link travels.
          expect(parentRow?.parentSessionId).toBeUndefined()
          expect(childRow?.parentSessionId).toBe(parent.sessionId)
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
          const spawned = yield* harness.client.session.create({
            cwd: "/nonexistent/spawned",
            ...parent,
          })
          // A handoff continues the parent's thread.
          const handoff = yield* harness.client.session.create({
            cwd: "/nonexistent/handoff",
            continueThread: true,
            ...parent,
          })

          // A child may name only its parent session.
          const sessionOnly = yield* harness.client.session.create({
            cwd: "/nonexistent/session-only",
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
    "a root listing holds that session's subtree and no session beside it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* openHarness
          const child = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-child",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })
          const grandchild = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc-grandchild",
            parentSessionId: child.sessionId,
            parentBranchId: child.branchId,
          })
          // Another conversation in the same workspace.
          const beside = yield* harness.client.session.create({
            cwd: "/nonexistent/agents-view-rpc",
          })

          const { reply } = yield* requestRows(harness, { root: harness.sessionId })
          expect(reply.rows.map((row) => row.sessionId).toSorted()).toEqual(
            [harness.sessionId, child.sessionId, grandchild.sessionId].toSorted(),
          )
          // The root's own loop is live, so its row still carries the live half.
          expect(reply.rows.find((row) => row.sessionId === harness.sessionId)?.live).toBe(true)
          const whole = yield* requestRows(harness, {})
          expect(whole.reply.rows.map((row) => row.sessionId)).toContain(beside.sessionId)
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
