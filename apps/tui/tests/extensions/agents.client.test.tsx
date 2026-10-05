/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Deferred, Effect, Exit, Layer, Option, Predicate, Scope } from "effect"
import { TestClock } from "effect/testing"
import { createSignal, Show } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import {
  type AgentRowEntry,
  BTW_EXTENSION_ID,
  DELEGATE_EXTENSION_ID,
  type ListAgentsInput,
  SESSION_TOOLS_EXTENSION_ID,
} from "@gent/extensions/client"
import {
  default as agentsExtension,
  AgentsPane,
  detailLabel,
  makeAgentsController,
  SubagentTray,
  trayLines,
} from "../../src/extensions/agents.client"
import {
  ClientContext,
  makeClientContextLayer,
  type ExtensionAgentDetail,
  STATUS_YIELD,
  type StatusLabelItem,
} from "../../src/extensions/client-facets"
import { StatusRow } from "../../src/composer"
import { resolveThemeColor, useTheme } from "../../src/theme"
import { DockProvider, PickerFrame } from "../../src/ui"
import { RGBA } from "@opentui/core"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderScoped,
} from "../render-harness-boundary"
import { useCommand } from "../../src/commands"
import { useScopedKeyboard } from "../../src/terminal"
import { waitForFrame, waitUntil, waitUntilAdvancing } from "../helpers-boundary"
// oxlint-disable-next-line gent/declared-workspace-imports -- the gamut live-check driver is in no workspace; its pane predicate is checked on this renderer's frames
import { paneShowsWorkingChild } from "../../../../testbeds/gamut/gamut"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  makePaneSlot,
  provideClientServices,
  testClientContextDeps,
  runClientExtensionSetup,
} from "../extension-test-harness-boundary"

/** A session in view that no listed row is. */
const ELSEWHERE = { sessionId: SessionId.make("elsewhere"), branchId: BranchId.make("elsewhere") }

/** Where the TUI launched: a child's call reads its paths against it. */
const PLACE = { cwd: "/work", home: "/home/me" }

// ── agents controller ───────────────────────────────────────────────────────

/**
 * Detail fetching for the agents view.
 *
 * Arrow keys move faster than a round trip, so replies can land out of order.
 * These cover the rule that only the reply for the row still selected wins —
 * without it, one row's cost renders next to another row's name.
 */

const row = (id: string, live = true): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "idle",
  live,
  depth: 0,
  sideThread: false,
})

const detail = (turns: number): ExtensionAgentDetail => ({
  status: "Idle",
  model: Option.some("anthropic/claude-sonnet-5"),
  turns,
  costUsd: 0,
  durationMs: 0,
  omittedMessages: 0,
  effort: Option.none(),
  firstPrompt: Option.none(),
  lastAnswer: Option.none(),
})

describe("Agents controller detail", () => {
  it.scopedLive("ignores a reply for a row the reader already moved off", () =>
    Effect.gen(function* () {
      // Stands in for the client's `cast`, which runs effects on the shell's
      // own runtime; here that is the surrounding test context.
      const slow = yield* Deferred.make<ExtensionAgentDetail>()
      const fast = yield* Deferred.make<ExtensionAgentDetail>()
      const gates = new Map([
        ["first", slow],
        ["second", fast],
      ])

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          (key) =>
            Option.match(Option.fromUndefinedOr(gates.get(key.sessionId)), {
              onNone: () => Effect.never,
              onSome: (gate) => Deferred.await(gate),
            }),
        ),
      )

      // Select the first row, then move on before its reply arrives.
      controller.select(Option.some(row("first")))
      controller.select(Option.some(row("second")))

      // The stale reply lands first and must not be shown.
      yield* Deferred.succeed(slow, detail(111))
      yield* Effect.yieldNow
      expect(controller.detail()).toEqual(Option.none())

      // The reply for the row still selected is the one that wins.
      yield* Deferred.succeed(fast, detail(222))
      yield* Effect.yieldNow
      expect(Option.map(controller.detail(), (value) => value.turns)).toEqual(Option.some(222))
    }),
  )

  it.scopedLive("clears detail when the selection goes away", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ExtensionAgentDetail>()

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          () => Deferred.await(gate),
        ),
      )

      controller.select(Option.some(row("only")))
      yield* Deferred.succeed(gate, detail(5))
      yield* Effect.yieldNow
      expect(Option.isSome(controller.detail())).toBe(true)

      controller.select(Option.none())
      expect(controller.detail()).toEqual(Option.none())
    }),
  )
})

describe("Agents controller reload", () => {
  it.scopedLive("keeps the pane filter on reload and reads complete activity separately", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []

      const controller = yield* provideClientServices(
        makeAgentsController(
          ({ query }) => {
            asked.push(query ?? "")
            return Effect.succeed([])
          },
          () => Effect.never,
        ),
        {
          currentSession: () => ({
            sessionId: SessionId.make("only"),
            branchId: BranchId.make("only"),
          }),
        },
      )

      // The reader filters the pane, then deletes a row from it. The listing
      // that comes back must still be the filtered one.
      controller.refresh("dep")
      controller.reload()
      yield* Effect.yieldNow

      expect(asked).toEqual(["", "dep", "", "dep", ""])
    }),
  )
})

describe("Agents controller listing scope", () => {
  it.scopedLive(
    "the closed pane reads the current session's subtree, the open pane every session",
    () =>
      Effect.gen(function* () {
        const asked: Array<ListAgentsInput> = []
        const pane = makePaneSlot()
        const controller = yield* provideClientServices(
          makeAgentsController(
            (input) => {
              asked.push(input)
              return Effect.succeed([])
            },
            () => Effect.never,
          ),
          {
            currentSession: () => ({
              sessionId: SessionId.make("here"),
              branchId: BranchId.make("here"),
            }),
            shell: { pane },
          },
        )

        // Initial controller knowledge reads one subtree without the tray.
        yield* Effect.yieldNow
        pane.open("agents.pane")
        controller.refresh("")
        yield* Effect.yieldNow

        // Strict: an in-process request refuses an input with an `undefined`
        // key as no JSON value, so the open pane's input has no `root` key.
        expect(asked).toStrictEqual([{ query: "", root: SessionId.make("here") }, { query: "" }])
      }),
  )
})

describe("Agents controller stored rows", () => {
  it.scopedLive("never asks a stored session for detail, since the read would spawn its loop", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed(detail(1))
          },
        ),
      )
      controller.select(Option.some(row("stored", false)))
      expect(asked).toEqual([])
      expect(controller.detail()).toEqual(Option.none())
    }),
  )
})

describe("Agents pane refresh while open", () => {
  const parentKey = {
    sessionId: SessionId.make("parent"),
    branchId: BranchId.make("parent-branch"),
  }
  /** One poll period of the controller, on a clock the test moves. */
  const POLL = "2 seconds"

  it.scopedLive("a child that finishes while the pane is open is read again, with its detail", () =>
    Effect.gen(function* () {
      // The child's own turn raises no event in the parent's session, so only
      // the poll can see it end. The pane is open the whole time.
      let status: "Running" | "Idle" = "Running"
      let turns = 0
      const sectionOf = {
        Running: "running",
        Idle: "idle",
      } satisfies Record<"Running" | "Idle", AgentRowEntry["section"]>
      const section = () => sectionOf[status]
      const listed = (): ReadonlyArray<AgentRowEntry> => [
        { ...row("parent"), section: section(), status: "Idle" },
        { ...row("child"), section: section(), status, parentSessionId: parentKey.sessionId },
      ]
      const pane = makePaneSlot()
      pane.open("agents.pane")
      const clock = yield* TestClock.make()
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.sync(listed),
          () => Effect.sync(() => ({ ...detail(turns), status })),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
        { currentSession: () => parentKey, shell: { pane } },
      )
      controller.refresh("")
      yield* waitUntil(() => controller.rows().length === 2, "first listing")
      controller.select(Option.some(listed()[1] ?? row("child")))
      yield* waitUntil(
        () => Option.exists(controller.detail(), (value) => value.status === "Running"),
        "child detail running",
      )

      status = "Idle"
      turns = 1
      yield* waitUntilAdvancing(
        clock.adjust(POLL),
        () => controller.rows().every((entry) => entry.status === "Idle"),
        "listing after the child finished",
      )
      yield* waitUntil(
        () =>
          Option.exists(
            controller.detail(),
            (value) => value.status === "Idle" && value.turns === 1,
          ),
        "selected detail after the child finished",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("the closed tray polls only while a descendant has a live loop", () =>
    Effect.gen(function* () {
      let childLive = false
      let listings = 0
      const listed = (): ReadonlyArray<AgentRowEntry> => {
        const entry = { ...row("child", childLive), parentSessionId: parentKey.sessionId }
        if (childLive) return [entry]
        // A stored child has no loop, so it is inactive.
        return [{ ...entry, section: "inactive" }]
      }
      const clock = yield* TestClock.make()
      const controller = yield* provideClientServices(
        makeAgentsController(
          () =>
            Effect.sync(() => {
              listings += 1
              return listed()
            }),
          () => Effect.succeed(detail(1)),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
        { currentSession: () => parentKey },
      )
      yield* waitUntil(() => controller.rows().length === 1, "first listing")

      // Only a stored child: several poll periods pass and nothing is listed.
      for (let period = 0; period < 3; period++) {
        yield* clock.adjust(POLL)
        yield* Effect.yieldNow
      }
      expect(listings).toBe(1)

      // The child's loop starts (a delegate pulse would re-read); the poll resumes.
      childLive = true
      controller.refresh("")
      yield* waitUntilAdvancing(clock.adjust(POLL), () => listings >= 4, "polls for a live child")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("the selected detail is read again only when its listing row moved", () =>
    Effect.gen(function* () {
      let updatedAt = 1
      let listings = 0
      let detailReads = 0
      const listed = (): ReadonlyArray<AgentRowEntry> => [
        { ...row("child"), status: "Idle", updatedAt, parentSessionId: parentKey.sessionId },
      ]
      const pane = makePaneSlot()
      pane.open("agents.pane")
      const clock = yield* TestClock.make()
      const controller = yield* provideClientServices(
        makeAgentsController(
          () =>
            Effect.sync(() => {
              listings += 1
              return listed()
            }),
          () =>
            Effect.sync(() => {
              detailReads += 1
              return detail(detailReads)
            }),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
        { currentSession: () => parentKey, shell: { pane } },
      )
      controller.refresh("")
      yield* waitUntil(() => controller.rows().length === 1, "first listing")
      controller.select(Option.some(listed()[0] ?? row("child")))
      yield* waitUntil(() => Option.isSome(controller.detail()), "first detail")

      // Polls whose listing shows the row as it was read ask nothing more.
      yield* waitUntilAdvancing(clock.adjust(POLL), () => listings >= 4, "three polls")
      expect(detailReads).toBe(1)

      // A step moves the row's `updatedAt`; the next listing reads the detail again.
      updatedAt = 2
      yield* waitUntilAdvancing(clock.adjust(POLL), () => detailReads === 2, "detail after a step")
      const settled = listings
      yield* waitUntilAdvancing(clock.adjust(POLL), () => listings >= settled + 3, "later polls")
      expect(detailReads).toBe(2)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a running row's detail is read on each poll while its listing row stays the same",
    () =>
      Effect.gen(function* () {
        let listings = 0
        let detailReads = 0
        // A turn that stays running between its steps: the listing row does not move.
        const listed = (): ReadonlyArray<AgentRowEntry> => [
          {
            ...row("child"),
            section: "running",
            status: "Running",
            updatedAt: 1,
            parentSessionId: parentKey.sessionId,
          },
        ]
        const pane = makePaneSlot()
        pane.open("agents.pane")
        const clock = yield* TestClock.make()
        const controller = yield* provideClientServices(
          makeAgentsController(
            () =>
              Effect.sync(() => {
                listings += 1
                return listed()
              }),
            () =>
              Effect.sync(() => {
                detailReads += 1
                return { ...detail(1), status: "Running", costUsd: detailReads / 100 }
              }),
          ).pipe(Effect.provideService(Clock.Clock, clock)),
          { currentSession: () => parentKey, shell: { pane } },
        )
        controller.refresh("")
        yield* waitUntil(() => controller.rows().length === 1, "first listing")
        controller.select(Option.some(listed()[0] ?? row("child")))
        yield* waitUntil(() => Option.isSome(controller.detail()), "first detail")
        const firstReads = detailReads

        // Each poll reads the detail again; the cost the pane shows follows it.
        yield* waitUntilAdvancing(
          clock.adjust(POLL),
          () => detailReads >= firstReads + 3,
          "a detail read per poll",
        )
        yield* waitUntil(
          () => Option.exists(controller.detail(), (shown) => shown.costUsd === detailReads / 100),
          "the latest cost",
        )
        expect(listings).toBeGreaterThanOrEqual(4)
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a read slower than the poll still lands, and only one read runs at a time", () =>
    Effect.gen(function* () {
      let status: "Running" | "Idle" = "Running"
      let rowsInFlight = 0
      let detailInFlight = 0
      let mostRows = 0
      let mostDetail = 0
      const listed = (): ReadonlyArray<AgentRowEntry> => [
        { ...row("child"), status, parentSessionId: parentKey.sessionId },
      ]
      const clock = yield* TestClock.make()
      // Each read takes several poll periods: the test moves the poll clock
      // while a read, on the live clock, is still out.
      const slow = <A,>(read: () => A, count: (delta: number) => number) =>
        Effect.acquireUseRelease(
          Effect.sync(() => count(1)),
          // A read slower than the poll is the subject
          () => Effect.sleep("120 millis").pipe(Effect.map(read)),
          () => Effect.sync(() => count(-1)),
        )
      const pane = makePaneSlot()
      pane.open("agents.pane")
      const controller = yield* provideClientServices(
        makeAgentsController(
          () =>
            slow(listed, (delta) => {
              rowsInFlight += delta
              mostRows = Math.max(mostRows, rowsInFlight)
              return rowsInFlight
            }),
          () =>
            slow(
              () => ({ ...detail(0), status }),
              (delta) => {
                detailInFlight += delta
                mostDetail = Math.max(mostDetail, detailInFlight)
                return detailInFlight
              },
            ),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
        { currentSession: () => parentKey, shell: { pane } },
      )
      controller.refresh("")
      yield* waitUntil(() => controller.rows().length === 1, "first listing")
      controller.select(Option.some(listed()[0] ?? row("child")))
      yield* waitUntil(
        () => Option.exists(controller.detail(), (value) => value.status === "Running"),
        "child detail running",
      )
      status = "Idle"
      yield* waitUntilAdvancing(
        clock.adjust(POLL),
        () => controller.rows().every((entry) => entry.status === "Idle"),
        "listing after the child finished",
      )
      yield* waitUntilAdvancing(
        clock.adjust(POLL),
        () => Option.exists(controller.detail(), (value) => value.status === "Idle"),
        "detail after the child finished",
      )
      expect(mostRows).toBe(1)
      expect(mostDetail).toBe(1)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a delegate pulse re-reads the open pane under its filter, the tray under none",
    () =>
      Effect.gen(function* () {
        const asked: Array<string> = []
        const pulses = new Set<
          (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void
        >()
        const pane = makePaneSlot()
        // The poll clock never moves in this test: only the pulse reads.
        const clock = yield* TestClock.make()
        const controller = yield* provideClientServices(
          makeAgentsController(
            ({ query }) => {
              asked.push(query ?? "")
              return Effect.succeed([])
            },
            () => Effect.never,
          ).pipe(Effect.provideService(Clock.Clock, clock)),
          {
            currentSession: () => parentKey,
            shell: { pane },
            transport: {
              ...makeClientTestTransport({ currentSession: () => parentKey }),
              onExtensionStateChanged: (cb) => {
                pulses.add(cb)
                return () => {
                  pulses.delete(cb)
                }
              },
            },
          },
        )
        const pulse = (extensionId: string) => {
          for (const cb of pulses) cb({ ...parentKey, extensionId })
        }

        pane.open("agents.pane")
        controller.refresh("dep")
        pulse(DELEGATE_EXTENSION_ID)
        pulse("@gent/other")
        expect(asked).toEqual(["", "dep", "", "dep", ""])

        // Closed, the pulse feeds the tray, which lists the whole subtree.
        pane.close("agents.pane")
        pulse(DELEGATE_EXTENSION_ID)
        expect(asked).toEqual(["", "dep", "", "dep", "", ""])
      }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── agents pane ─────────────────────────────────────────────────────────────

/**
 * Keyboard navigation for the agents pane: an arrow selects, Enter fires
 * onSelect, Escape clears a typed filter and then closes.
 */

const rowPane = (id: string, name: string, depth: number): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "inactive",
  name,
  live: false,
  depth,
  sideThread: false,
})

/**
 * A rowPane that has run, so `ageFor` yields a real age.
 *
 * The age is the only part of a rowPane drawn against the right edge, so a
 * fixture without `updatedAt` cannot overflow the budget however long its
 * name is: the width tests above passed against a visibly wrapping pane
 * because every rowPane they drew had an empty age column.
 *
 * `updatedAt` is an instant the caller resolves from the clock, not a
 * duration: the pane reads the wall clock to format the age.
 */
const agedRow = (id: string, name: string, updatedAt: number): AgentRowEntry => ({
  ...rowPane(id, name, 0),
  section: "idle",
  live: true,
  updatedAt,
})

describe("Agents pane navigation", () => {
  it.scopedLive("selects a child with the keyboard and closes with Escape", () =>
    Effect.gen(function* () {
      const parent = rowPane("agents-root", "Alpha", 0)
      const child = rowPane("agents-child", "Beta", 1)
      let selected = Option.none<AgentRowEntry>()
      const [open, setOpen] = createSignal(true)

      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={open()}
          controller={{
            rows: () => [parent, child],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () => Option.none(),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={(value) => {
            selected = Option.some(value)
          }}
          onDelete={() => {}}
          onClose={() => setOpen(false)}
        />
      ))

      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(selected).toEqual(Option.some(child))

      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => !open(), "agents pane closed")
      expect(open()).toBe(false)
      expect(renderFrame(setup)).not.toContain("Sessions ·")
    }),
  )

  it.scopedLive("Escape clears a typed filter first, then closes the pane", () =>
    Effect.gen(function* () {
      const queries: Array<string> = []
      const [open, setOpen] = createSignal(true)
      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={open()}
          controller={{
            rows: () => [rowPane("agents-root", "Alpha", 0)],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: (query) => queries.push(query),
            reload: () => {},
            detail: () => Option.none(),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => setOpen(false)}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("Alpha"), "agents pane")
      setup.mockInput.pressKey("a")
      yield* waitForFrame(setup, (frame) => frame.includes("› a"), "typed filter")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("› a"), "filter cleared")
      expect(open()).toBe(true)
      expect(queries.at(-1)).toBe("")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => !open(), "agents pane closed")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a poll that lists the same sessions again leaves the cursor on the reader's row",
    () =>
      Effect.gen(function* () {
        // Every poll decodes fresh row objects. The pane opens on the session
        // the shell is on; the reader moves off it, and the next poll must not
        // pull the cursor back.
        const listing = () => [
          rowPane("agents-root", "Alpha", 0),
          rowPane("agents-child", "Beta", 1),
          rowPane("agents-other", "Gamma", 1),
        ]
        const [rows, setRows] = createSignal<ReadonlyArray<AgentRowEntry>>(listing())
        let selected = Option.none<AgentRowEntry>()

        const setup = yield* renderScoped(() => (
          <AgentsPane
            place={PLACE}
            open={true}
            controller={{
              rows,
              current: () => ({
                sessionId: SessionId.make("agents-root"),
                branchId: BranchId.make("agents-root-branch"),
              }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open: () => true,
            }}
            onSelect={(value) => {
              selected = Option.some(value)
            }}
            onDelete={() => {}}
            onClose={() => {}}
          />
        ))
        yield* waitForFrame(setup, () => renderFrame(setup).includes("Gamma"), "agents pane open")

        setup.mockInput.pressArrow("down")
        setup.mockInput.pressArrow("down")
        yield* Effect.promise(() => setup.renderOnce())
        setRows(listing())
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        expect(Option.map(selected, (row) => row.sessionId)).toEqual(
          Option.some(SessionId.make("agents-other")),
        )

        // A poll that no longer lists the reader's row keeps the cursor in the list.
        setRows(listing().slice(0, 2))
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        expect(Option.map(selected, (row) => row.sessionId)).toEqual(
          Option.some(SessionId.make("agents-child")),
        )
      }),
  )

  it.scopedLive("asks for detail about the row under the cursor and renders it", () =>
    Effect.gen(function* () {
      const parent = rowPane("detail-root", "Alpha", 0)
      const child = rowPane("detail-child", "Beta", 1)
      const asked: Array<string> = []
      const [detail, setDetail] = createSignal(Option.none<ExtensionAgentDetail>())

      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => [parent, child],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail,
            done: () => [],
            select: (selection) => {
              Option.match(selection, {
                onNone: () => {},
                onSome: (value) => {
                  asked.push(value.sessionId)
                  setDetail(
                    Option.some({
                      status: "Idle",
                      model: Option.some("anthropic/claude-sonnet-5"),
                      turns: 7,
                      costUsd: 0.125,
                      durationMs: 93_000,
                      omittedMessages: 0,
                      effort: Option.none(),
                      firstPrompt: Option.none(),
                      lastAnswer: Option.none(),
                    }),
                  )
                },
              })
            },
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ))

      // The first row is selected on open, so its detail is requested without
      // any keypress; moving down asks about the row now under the cursor.
      expect(asked).toEqual(["detail-root"])
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["detail-root", "detail-child"])

      const frame = renderFrame(setup)
      expect(frame).toContain("claude-sonnet-5")
      expect(frame).not.toContain("anthropic/")
      expect(frame).toContain("7 turns")
      expect(frame).toContain("$0.13")
      expect(frame).toContain("1m33s")
    }),
  )

  it.scopedLive("corrects the selected row's section from live state", () =>
    Effect.gen(function* () {
      // The listing has to report a resident loop as idle — it never reads
      // state — so the detail read is the only thing that knows better.
      const busy: AgentRowEntry = { ...rowPane("busy", "Alpha", 0), section: "idle", live: true }

      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => [busy],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () =>
              Option.some({
                status: "Running",
                model: Option.some("anthropic/claude-sonnet-5"),
                turns: 1,
                costUsd: 0,
                durationMs: 0,
                omittedMessages: 0,
                effort: Option.none(),
                firstPrompt: Option.none(),
                lastAnswer: Option.none(),
              }),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ))

      const frame = renderFrame(setup)
      expect(frame).toContain("Idle (1)")
      // The glyph says it runs; no state word repeats it.
      expect(frame).toMatch(/[◇◈◆] Alpha/)
      expect(frame).not.toContain("· running")
    }),
  )

  it.scopedLive("a selected row waiting on an answer says so: no glyph shows it", () =>
    Effect.gen(function* () {
      const busy: AgentRowEntry = { ...rowPane("ask", "Alpha", 0), section: "running", live: true }
      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => [busy],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () =>
              Option.some({
                status: "WaitingForInteraction",
                model: Option.none(),
                turns: 1,
                costUsd: 0,
                durationMs: 0,
                omittedMessages: 0,
                effort: Option.none(),
                firstPrompt: Option.none(),
                lastAnswer: Option.none(),
              }),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ))
      expect(renderFrame(setup)).toContain("Alpha · waiting for an answer")
    }),
  )

  it.scopedLive("a selected idle row draws its dot and no state word", () =>
    Effect.gen(function* () {
      const idle: AgentRowEntry = { ...rowPane("rest", "Alpha", 0), section: "idle", live: true }
      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => [idle],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () => Option.some(detail(1)),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("○ Alpha")
      expect(frame).not.toContain("Alpha · idle")
    }),
  )

  it.scopedLive("← opens the pane and the pane's own ← closes it; ctrl+t is bound to nothing", () =>
    Effect.gen(function* () {
      const runtime = makeClientExtensionRuntime({ requestReply: { rows: [] } })
      const contributions = yield* runClientExtensionSetup(runtime, agentsExtension)
      const commands = contributions.commands ?? []
      expect(commands.filter((command) => command.keybind === "left").map(({ id }) => id)).toEqual([
        "agents.view",
      ])
      expect(commands.some((command) => command.keybind === "ctrl+t")).toBe(false)
      const pane = Option.getOrThrow(
        Option.fromUndefinedOr(contributions.widgets?.find((w) => w.id === "agents.pane")),
      )
      // The session's keybind dispatch over an empty composer, as the session view runs it.
      const Session = () => {
        const command = useCommand()
        useScopedKeyboard((event) => command.handleKeybind(event, commands, true))
        return <pane.component />
      }
      const setup = yield* renderScoped(() => <Session />)
      const paneOpen = (frame: string) => frame.includes("esc close")
      setup.mockInput.pressKey("t", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(paneOpen(renderFrame(setup))).toBe(false)

      setup.mockInput.pressArrow("left")
      const opened = yield* waitForFrame(setup, paneOpen, "the pane opened by ←")
      expect(opened).not.toContain("ctrl+t")
      setup.mockInput.pressArrow("left")
      yield* waitForFrame(setup, (frame) => !paneOpen(frame), "the pane closed by its own ←")
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
})

describe("Agents pane delete", () => {
  it.scopedLive("Ctrl+X arms the row in place and a second press deletes it", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = []
      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => [rowPane("doomed", "Alpha", 0)],
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () => Option.none(),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={(target) => deleted.push(target.sessionId)}
          onClose={() => {}}
        />
      ))

      setup.mockInput.pressKey("x", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("ctrl+x again to delete")
      expect(deleted).toEqual([])

      setup.mockInput.pressKey("x", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(deleted).toEqual(["doomed"])
      expect(renderFrame(setup)).not.toContain("ctrl+x again")
    }),
  )
})

describe("Agents pane reopen", () => {
  it.scopedLive("a live row asked about before closing is asked about again on reopen", () =>
    Effect.gen(function* () {
      // The pane unmounts its list on close, so the list never observes
      // `open=false`. Without a cursor reset from cleanup, the controller keeps
      // the pending token for the row it last fetched and the duplicate check
      // swallows the fresh detail the reader reopened the pane to see.
      const live: AgentRowEntry = {
        ...rowPane("reopened", "Alpha", 0),
        section: "idle",
        live: true,
      }
      const asked: Array<string> = []
      const [open, setOpen] = createSignal(true)
      const [turns, setTurns] = createSignal(1)

      // The shell is on this loop. The listing is keyed on it, so a reply
      // is kept only while it is still the current session.
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([live]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed({
              status: "Idle",
              model: Option.some("anthropic/claude-sonnet-5"),
              turns: turns(),
              costUsd: 0,
              durationMs: 0,
              omittedMessages: 0,
              effort: Option.none(),
              firstPrompt: Option.none(),
              lastAnswer: Option.none(),
            })
          },
        ),
        {
          currentSession: () => ({ sessionId: live.sessionId, branchId: live.branchId }),
        },
      )

      const setup = yield* renderScoped(() => (
        <AgentsPane
          place={PLACE}
          open={open()}
          controller={controller}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => setOpen(false)}
        />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["reopened"])

      // The pane closes and its list unmounts.
      setOpen(false)
      yield* waitForFrame(setup, () => !open(), "agents pane closed")

      // The loop keeps working while the pane is shut.
      setTurns(9)

      // Reopening must ask again, not reuse the token from before the close.
      setOpen(true)
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["reopened", "reopened"])
      expect(Option.map(controller.detail(), (value) => value.turns)).toEqual(Option.some(9))
    }),
  )
})

describe("Agents pane framing", () => {
  it.scopedLive(
    "presents as the slash-command popup does: ruled off, titled, one muted footer",
    () =>
      Effect.gen(function* () {
        // The pane reads as a continuation of the composer, not a floating box
        // over the transcript: the same frame the autocomplete popup draws.
        const idle: AgentRowEntry = {
          ...rowPane("framed", "Alpha", 0),
          section: "idle",
          live: true,
        }
        const setup = yield* renderScoped(
          () => (
            <AgentsPane
              place={PLACE}
              open={true}
              controller={{
                rows: () => [idle],
                current: () => ELSEWHERE,
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () =>
                  Option.some({
                    status: "Idle",
                    model: Option.some("anthropic/claude-sonnet-5"),
                    turns: 7,
                    costUsd: 0.125,
                    durationMs: 93_000,
                    omittedMessages: 0,
                    effort: Option.none(),
                    firstPrompt: Option.none(),
                    lastAnswer: Option.none(),
                  }),
                select: () => {},
                done: () => [],
                open: () => true,
              }}
              onSelect={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        )
        yield* waitForFrame(setup, (frame) => frame.includes("esc close"), "agents pane")
        const lines = renderFrame(setup).split("\n")

        // Ruled top and bottom, never the rounded box a docked pane draws.
        const rules = lines.filter((line) => line.startsWith("────"))
        expect(rules.length).toBe(2)
        expect(renderFrame(setup)).not.toContain("╭")
        expect(renderFrame(setup)).not.toContain("╰")

        // The title carries its counts, on the first line inside the top rule.
        const top = lines.findIndex((line) => line.startsWith("────"))
        expect(lines[top + 1]).toContain("Sessions · 1 idle")
        expect(lines[top + 1]).not.toContain("running")

        // One muted footer line, immediately under the bottom rule.
        const bottom = lines.findLastIndex((line) => line.startsWith("────"))
        expect(lines[bottom + 1]).toContain("↑↓ move · enter select · ctrl+x delete · esc close")

        // Every capability the pane had inside the bordered box still draws:
        // the section heading, the row, and the detail line, each on its own
        // line. The picker height rule counts items, so a pane that budgeted
        // rows rather than drawn lines overprints these.
        const body = lines.slice(top + 1, bottom)
        expect(body.some((line) => line.includes("Idle (1)"))).toBe(true)
        expect(body.some((line) => line.includes("Alpha"))).toBe(true)
        expect(
          body.some((line) => line.includes("claude-sonnet-5") && line.includes("7 turns")),
        ).toBe(true)
      }),
  )

  it.scopedLive("budgets a row the full width the rule spans, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The frame rules off top and bottom and has no side border or margin,
      // so a row spends only its own left pad. Budgeting a docked pane's
      // allowance here truncates every row five columns short of the rule.
      const wide = rowPane("wide", "W".repeat(200), 0)
      const setup = yield* renderScoped(
        () => (
          <AgentsPane
            place={PLACE}
            open={true}
            controller={{
              rows: () => [wide],
              current: () => ELSEWHERE,
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open: () => true,
            }}
            onSelect={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        ),
        { width: 80, height: 40 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("WWW"), "wide row")
      const lines = renderFrame(setup).split("\n")
      const rule = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.startsWith("────"))),
      )
      // Only the row itself: the heading also holds a "W", in "Inactive".
      const rowLine = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.includes("WWW"))),
      )
      // A row spends exactly 3 of the rule's columns: the list body pads 1
      // each side and the row pads 1 more on the left. Landing on that number
      // says the budget is the picker's — a docked pane's allowance would cut
      // the row 5 columns further in — and that it is not overspent, which
      // wraps the age onto a line of its own.
      expect(rowLine.trimEnd().length).toBe(rule.trimEnd().length - 3)
    }),
  )

  it.scopedLive("keeps each row's age on the row's own line in a narrow pane", () =>
    Effect.gen(function* () {
      // A row is drawn inside the list body, which pads a column each side,
      // and pads one more itself. A budget that counts only the row's own pad
      // draws a line as wide as the terminal, and the age wraps onto a line of
      // its own. An overlong label is cut so that its age keeps its place.
      const now = yield* Clock.currentTimeMillis
      const aged = agedRow("aged", "New Chat", now - 60_000)
      const long = agedRow("long", "L".repeat(400), now - 2 * 24 * 60 * 60 * 1000)
      const setup = yield* renderScoped(
        () => (
          <AgentsPane
            place={PLACE}
            open={true}
            controller={{
              rows: () => [aged, long],
              current: () => ELSEWHERE,
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open: () => true,
            }}
            onSelect={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        ),
        { width: 58, height: 24 },
      )
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("New Chat") && frame.includes("LLL"),
        "both rows",
      )
      const lines = renderFrame(setup).split("\n")
      const rule = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.startsWith("────"))),
      )

      // The age rides the row that names the agent, not a line by itself.
      const rowLine = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.includes("New Chat"))),
      )
      expect(rowLine).toContain("1m")
      expect(lines.some((line) => line.trim() === "1m")).toBe(false)

      // One line carries the cut label, and it carries the age too.
      const labelLines = lines.filter((line) => line.includes("LLL"))
      expect(labelLines.length).toBe(1)
      expect(labelLines[0]).toContain("2d")
      expect(lines.some((line) => line.trim() === "2d")).toBe(false)

      // Each row ends one column short of the rule: the body keeps its right
      // pad. A row that reaches the rule has overspent, and that is what
      // pushes the age onto the next line.
      expect(rowLine.trimEnd().length).toBe(rule.trimEnd().length - 1)
      expect(labelLines[0]?.trimEnd().length).toBe(rule.trimEnd().length - 1)
    }),
  )

  it.scopedLive("keeps the error surface inside the frame", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <AgentsPane
            place={PLACE}
            open={true}
            controller={{
              rows: () => [rowPane("erred", "Alpha", 0)],
              current: () => ELSEWHERE,
              error: () => Option.some("listing failed"),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open: () => true,
            }}
            onSelect={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        ),
        { width: 80, height: 40 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("listing failed"), "error row")
      const lines = renderFrame(setup).split("\n")
      const top = lines.findIndex((line) => line.startsWith("────"))
      const bottom = lines.findLastIndex((line) => line.startsWith("────"))
      const body = lines.slice(top + 1, bottom)
      expect(body.some((line) => line.includes("listing failed"))).toBe(true)
    }),
  )
})

// ── subagent tray ───────────────────────────────────────────────────────────

/**
 * The subagent tray under the status line.
 *
 * One dim line per running child of the current session, from the same rows
 * the agents pane lists; hidden while nothing runs, and while the pane is open.
 */

/** A row whose own loop is in `section`: a live row carries the status the listing reads. */
const root = (id: string, section: AgentRowEntry["section"]): AgentRowEntry => {
  const entry: AgentRowEntry = {
    sessionId: SessionId.make(id),
    branchId: BranchId.make(`${id}-branch`),
    section,
    live: section !== "inactive",
    depth: 0,
    sideThread: false,
  }
  if (section === "running") return { ...entry, status: "Running" }
  if (section === "idle") return { ...entry, status: "Idle" }
  return entry
}

const child = (id: string, section: AgentRowEntry["section"], parent: string): AgentRowEntry => ({
  ...root(id, section),
  name: `delegate: ${id} task`,
  parentSessionId: SessionId.make(parent),
})

const rows = [
  root("root", "idle"),
  child("child-a", "running", "root"),
  child("child-b", "idle", "root"),
  child("grandchild", "inactive", "child-b"),
  root("other-root", "running"),
  child("other-child", "running", "other-root"),
]

describe("agents pane rows", () => {
  /** The pane over `listed`, in the order the server sent them, at `width` columns. */
  const paneOver = (listed: ReadonlyArray<AgentRowEntry>, width: number) =>
    renderScoped(
      () => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={{
            rows: () => listed,
            current: () => ELSEWHERE,
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () => Option.none(),
            select: () => {},
            done: () => [],
            open: () => true,
          }}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ),
      { width, height: 24 },
    )

  it.scopedLive(
    "each agent is one line with its glyph, task, what it does now and its time, running first, at 43 columns",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const listed: ReadonlyArray<AgentRowEntry> = [
          {
            ...child("worker", "running", "root"),
            name: "delegate: fix the loader",
            runningSince: now - 72_000,
            updatedAt: now - 1_000,
            runningCall: { tool: "bash", input: { command: "bun test" } },
          },
          { ...child("waiting", "idle", "root"), updatedAt: now - 180_000 },
          { ...child("stored", "inactive", "root"), updatedAt: now - 2 * 3_600_000 },
        ]
        const setup = yield* paneOver(listed, 43)
        const frame = yield* waitForFrame(setup, (next) => next.includes("Sessions ·"), "pane")
        const lines = frame.split("\n")
        const rule = lines.find((line) => line.startsWith("────")) ?? ""
        const lineOf = (text: string) => lines.findIndex((line) => line.includes(text))

        // The running agent: spinner, task, its current activity and how long it has run.
        const worker = lines[lineOf("· Running")] ?? ""
        expect(worker).toMatch(/[◇◈◆] delegate.* · Running/)
        expect(worker.trimEnd()).toMatch(/1m 1\ds$/)
        // The others: a ring for idle, a dot for stored, and the age of their last step.
        expect(lines[lineOf("waiting task")]).toContain("○ delegate: waiting task")
        expect(lines[lineOf("stored task")]).toContain("· delegate: stored task")
        expect(lines[lineOf("waiting task")]?.trimEnd()).toMatch(/3m$/)
        expect(lines[lineOf("stored task")]?.trimEnd()).toMatch(/2h$/)
        // Running first, in the order the server sent.
        expect(lineOf("· Running")).toBeLessThan(lineOf("waiting task"))
        expect(lineOf("waiting task")).toBeLessThan(lineOf("stored task"))
        // Each row fits inside the rule, with nothing wrapped onto a line of its own.
        for (const text of ["· Running", "waiting task", "stored task"]) {
          expect(lines.filter((line) => line.includes(text))).toHaveLength(1)
          expect(lines[lineOf(text)]?.trimEnd().length ?? 0).toBeLessThanOrEqual(
            rule.trimEnd().length,
          )
        }
      }),
  )

  it.scopedLive("a long task name leaves room for what the agent is doing", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const listed: ReadonlyArray<AgentRowEntry> = [
        {
          ...child("worker", "running", "root"),
          name: `delegate: ${"x".repeat(120)}`,
          runningSince: now - 5_000,
          runningCall: { tool: "read", input: { path: "src/loader.ts" } },
        },
      ]
      const setup = yield* paneOver(listed, 43)
      const frame = yield* waitForFrame(setup, (next) => next.includes("delegate:"), "pane")
      const row = frame.split("\n").find((line) => line.includes("delegate:")) ?? ""
      expect(row).toContain("…")
      expect(row).toContain("· Reading")
      expect(row.trimEnd()).toMatch(/\ds$/)
    }),
  )

  it.scopedLive("a child woken after it settled shows its current run time, not its age", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const listed: ReadonlyArray<AgentRowEntry> = [
        {
          ...child("woken", "running", "root"),
          createdAt: now - 2 * 3_600_000,
          updatedAt: now - 1_000,
          runningSince: now - 5_000,
          runningCall: { tool: "bash", input: { command: "bun test" } },
        },
      ]
      const setup = yield* paneOver(listed, 43)
      const frame = yield* waitForFrame(setup, (next) => next.includes("· Running"), "pane")
      const row = frame.split("\n").find((line) => line.includes("· Running")) ?? ""
      expect(row.trimEnd()).toMatch(/ [56]s$/)
      expect(row).not.toContain("2h")
    }),
  )

  it.scopedLive("a wide-character task name keeps the time on the row at 43 columns", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const listed: ReadonlyArray<AgentRowEntry> = [
        {
          ...child("cjk", "idle", "root"),
          name: "delegate: 修复加载器的所有问题并重新运行全部测试然后提交",
          updatedAt: now - 180_000,
        },
        {
          ...child("emoji", "inactive", "root"),
          name: "delegate: 🚀 ship 🧪 tests 👩‍💻 review 🔥🔥🔥🔥🔥🔥🔥🔥🔥",
          updatedAt: now - 2 * 3_600_000,
        },
        { ...child("waiting", "idle", "root"), updatedAt: now - 180_000 },
      ]
      const setup = yield* paneOver(listed, 43)
      const frame = yield* waitForFrame(setup, (next) => next.includes("delegate:"), "pane")
      const lines = frame.split("\n")
      const cjk = lines.find((line) => line.includes("修复")) ?? ""
      const emoji = lines.find((line) => line.includes("ship")) ?? ""
      const plain = lines.find((line) => line.includes("waiting task")) ?? ""
      // The name is cut once, by the row, not clipped again by the renderer.
      expect(cjk).toMatch(/delegate: 修复加载器.*…\s+3m/)
      expect(cjk).not.toContain("...")
      expect(emoji.trimEnd()).toMatch(/…\s+2h$/)
      // The time column ends on the same display column as a plain-text row.
      const edge = (row: string) => Bun.stringWidth(row.trimEnd())
      expect(edge(cjk)).toBe(edge(plain))
      expect(edge(emoji)).toBe(edge(plain))
    }),
  )
})

// ── command center ──────────────────────────────────────────────────────────

/**
 * The pane as an agent command center: what waits on the reader first, the
 * state in the glyph's shape, counts in the title, and a details column for
 * the selected row once the terminal is wide.
 */
describe("agents pane command center", () => {
  /**
   * The selected row's live detail: a delegate child parked on an ask, three
   * turns in. Its first prompt is its task under the parent's frame.
   */
  const asking: ExtensionAgentDetail = {
    status: "WaitingForInteraction",
    model: Option.some("anthropic/claude-sonnet-5-5"),
    effort: Option.some("high"),
    turns: 3,
    costUsd: 0.012,
    durationMs: 72_000,
    omittedMessages: 0,
    firstPrompt: Option.some(
      "Task from your parent session main. Your final reply in this turn is your result.\n\nCheck docs/architecture against the code\nThen report.",
    ),
    lastAnswer: Option.some("Which docs folder is current?"),
  }

  /** The pane over `listed` at `width` columns, with the theme it drew in. */
  const paneAt = (
    listed: ReadonlyArray<AgentRowEntry>,
    width: number,
    detail: Option.Option<ExtensionAgentDetail> = Option.some(asking),
  ) =>
    Effect.gen(function* () {
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          colors = Option.some(useTheme().theme)
          return (
            <AgentsPane
              place={PLACE}
              open={true}
              controller={{
                rows: () => listed,
                current: () => ELSEWHERE,
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => detail,
                select: () => {},
                done: () => [],
                open: () => true,
              }}
              onSelect={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          )
        },
        { width, height: 30 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("Sessions"), "pane")
      const lines = frame.split("\n")
      // The spans of the first line whose text holds `text`: a key with its
      // glyph finds the list row, not the details column's name line.
      const spansOf = (text: string) =>
        setup.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(text),
        )?.spans ?? []
      return { frame, lines, spansOf, theme: Option.getOrThrow(colors) }
    })

  const waiting = (now: number): ReadonlyArray<AgentRowEntry> => [
    {
      ...root("asks", "needs"),
      name: "check the docs",
      status: "WaitingForInteraction",
      cwd: "/home/me/work/docs",
      updatedAt: now - 12_000,
    },
    {
      ...root("questions", "needs"),
      name: "debug ask",
      status: "Idle",
      openQuestions: 1,
      updatedAt: now - 20_000,
    },
    {
      ...root("worker", "running"),
      name: "explore",
      runningSince: now - 41_000,
      runningCall: { tool: "read", input: { path: "ARCHITECTURE.md" } },
    },
  ]

  const resting = (now: number): ReadonlyArray<AgentRowEntry> => [
    { ...root("first", "idle"), name: "greeting", updatedAt: now - 5_000 },
    { ...root("rest", "idle"), name: "debug delegate", updatedAt: now - 9_000 },
    { ...root("stored", "inactive"), name: "debug scenario", updatedAt: now - 35_000 },
  ]

  for (const width of [100, 60, 40]) {
    it.scopedLive(
      `what waits on the reader comes first, each state in its glyph's shape, at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { lines, spansOf, theme } = yield* paneAt(waiting(now), width)
          const lineOf = (text: string) => lines.findIndex((line) => line.includes(text))
          // The title counts each state there is, and no state there is not.
          expect(lines[lineOf("Sessions")]).toContain(
            truncateTitle("Sessions · 2 needs you · 1 running", width),
          )
          expect(lines[lineOf("Sessions")]).not.toContain("0 ")
          // Needs you is the first section.
          expect(lineOf("Needs you (2)")).toBeGreaterThan(-1)
          expect(lineOf("Needs you (2)")).toBeLessThan(lineOf("Running (1)"))
          expect(lineOf("● check th")).toBeGreaterThan(lineOf("Needs you (2)"))
          expect(lineOf("● check th")).toBeLessThan(lineOf("Running (1)"))
          // A filled dot: the loop waits on the reader. The pulse: it works.
          // At 40 columns a long name is cut, but the glyph and the name lead.
          expect(lineOf("● debug ask")).toBeGreaterThan(lineOf("● check th"))
          expect(lines[lineOf("explore")]).toMatch(/[◇◈◆] explore/)
          if (width >= 60) {
            expect(lineOf("● check the docs · waiting for an answer")).toBeGreaterThan(-1)
            expect(lineOf("● debug ask · 1 open question")).toBeGreaterThan(-1)
            expect(lines[lineOf("explore")]).toContain("explore · Reading ARCHITECTURE.md")
          }
          // The dot is the attention colour; the name the agent-name colour.
          const asks = spansOf("● debug ask")
          expect(asks.find((span) => span.text.includes("●"))?.fg.equals(theme.warning)).toBe(true)
          expect(asks.find((span) => span.text.includes("debug ask"))?.fg.equals(theme.info)).toBe(
            true,
          )
          const works = spansOf("explore")
          expect(works.find((span) => /[◇◈◆]/.test(span.text))?.fg.equals(theme.text)).toBe(true)
        }),
    )

    it.scopedLive(`an idle loop draws a ring and a stored one a dot, at ${width} columns`, () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const { lines, spansOf, theme } = yield* paneAt(resting(now), width, Option.none())
        const lineOf = (text: string) => lines.findIndex((line) => line.includes(text))
        expect(lines[lineOf("Sessions")]).toContain(
          truncateTitle("Sessions · 2 idle · 1 inactive", width),
        )
        expect(lines[lineOf("Sessions")]).not.toContain("running")
        expect(lineOf("○ debug delegate")).toBeGreaterThan(-1)
        expect(lineOf("· debug scenario")).toBeGreaterThan(lineOf("○ debug delegate"))
        // Idle needs nothing: its ring is muted, as is a stored session's dot and name.
        // (The cursor sits on the first row, drawn in the selection's colours.)
        const idle = spansOf("○ debug delegate")
        expect(idle.find((span) => span.text.includes("○"))?.fg.equals(theme.textMuted)).toBe(true)
        const stored = spansOf("· debug scenario")
        expect(stored.find((span) => span.text.includes("·"))?.fg.equals(theme.textMuted)).toBe(
          true,
        )
        expect(
          stored.find((span) => span.text.includes("debug scenario"))?.fg.equals(theme.textMuted),
        ).toBe(true)
      }),
    )
  }

  it.scopedLive("at 100 columns the selected row's details stand in a column beside the list", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { frame, lines } = yield* paneAt(waiting(now), 100)
      // The column is ruled off at one place on every body line.
      const body = lines.filter((line) => line.includes("check the docs ·"))
      expect(body).toHaveLength(1)
      const rule = (body[0] ?? "").lastIndexOf("│")
      expect(rule).toBeGreaterThan(50)
      for (const text of [
        "● needs you · waiting for an answer",
        "claude-sonnet-5-5 · high",
        "turn 4 running · $0.01",
        "~/work/docs",
        "Which docs folder is current?",
        "Task: Check docs/architecture",
      ]) {
        const line = lines.find((candidate) => candidate.includes(text)) ?? ""
        expect(line.indexOf(text)).toBeGreaterThan(rule)
      }
      // A child's task reads without the parent's frame around it.
      expect(frame).not.toContain("Task from your parent")
      // The one-line detail under the list gives way to the column.
      expect(frame).not.toContain("claude-sonnet-5-5  ·  turn 4 running")
    }),
  )

  it.scopedLive("under 100 columns the one-line detail stays and no column draws", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { frame } = yield* paneAt(waiting(now), 60)
      expect(frame).toContain("claude-sonnet-5-5  ·  turn 4 running")
      expect(frame).not.toContain("claude-sonnet-5-5 · high")
      expect(frame).not.toContain("Task:")
    }),
  )
})

/** The title as a pane `width` columns wide draws it: cut to its section width. */
const truncateTitle = (title: string, width: number): string => {
  if (title.length <= width - 2) return title
  return title.slice(0, width - 3)
}

describe("the status row names the child the reader watches", () => {
  /** The labels the extension gives the status row while the shell is on a child named `name`. */
  const childLabels = (name: string) =>
    Effect.gen(function* () {
      const here = { sessionId: SessionId.make("kid"), branchId: BranchId.make("kid-branch") }
      const contributions = yield* provideClientServices(agentsExtension.setup, {
        requestReply: { rows: [{ ...child("kid", "running", "main"), name }] },
        currentSession: () => here,
      })
      const produce = contributions.statusLabels?.[0]?.produce ?? (() => [])
      yield* waitUntil(() => produce().length > 0, "the watched child's label")
      return produce()
    })

  it.scopedLive("viewing a child session shows ↳ child and its name, then the way back", () =>
    Effect.gen(function* () {
      const labels = yield* childLabels("explore")
      expect(labels.map((label) => label.text)).toEqual(["↳ child explore", "← sessions"])
      expect(labels[0]?.color).toBe("info")
      // On a narrow row the way back gives way after the debug mark, before the cwd.
      expect(labels[1]?.short?.text).toBe("")
      expect(labels[1]?.key).toBe("←")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a long child name is cut at a whole word", () =>
    Effect.gen(function* () {
      const labels = yield* childLabels("Check the greeting files (debug tools) and report back")
      expect(labels[0]?.text).toBe("↳ child Check the…")
      // The label gives way whole and first: before the debug mark, the way back and the cwd.
      expect(labels[0]?.short?.text).toBe("")
      expect(labels[0]?.short?.rank).toBeLessThan(STATUS_YIELD.debug)
      expect(labels[0]?.short?.rank).toBeLessThan(labels[1]?.short?.rank ?? -Infinity)
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a session with no parent shows no child label", () =>
    Effect.gen(function* () {
      const here = { sessionId: SessionId.make("main"), branchId: BranchId.make("main-branch") }
      let replied = false
      const contributions = yield* provideClientServices(agentsExtension.setup, {
        requestEffect: () =>
          Effect.sync(() => {
            replied = true
            return { rows: [root("main", "idle"), child("kid", "running", "main")] }
          }),
        currentSession: () => here,
      })
      const produce = contributions.statusLabels?.[0]?.produce ?? (() => [])
      yield* waitUntil(() => replied, "the listing read")
      expect(produce()).toEqual([])
    }).pipe(Effect.timeout("8 seconds")),
  )

  type HostRow = "plain" | "crowded"

  /**
   * The status row the app draws over a child's session: the host labels,
   * the extension's labels (`extra`), and the right group. A plain row has
   * the phase, the cwd and the model; a crowded one, as the live check drew
   * it, adds a provider, the effort and the git labels.
   */
  const statusRowAt = (width: number, host: HostRow, extra: ReadonlyArray<StatusLabelItem>) =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => {
          const { theme } = useTheme()
          const muted = (text: string, short?: { text: string; rank: number }) => ({
            text,
            color: theme.textMuted,
            short,
          })
          const ownLabels = extra.map((item) => ({
            ...item,
            color: resolveThemeColor(theme, item.color),
          }))
          const right = [muted("cache 5m"), muted("ctx 0%"), muted("$0.002")]
          const plain = [
            muted("idle", { text: "", rank: STATUS_YIELD.phase }),
            muted("repo", { text: "", rank: STATUS_YIELD.cwd }),
            muted("Claude Sonnet 5.5", { text: "Sonnet 5.5", rank: STATUS_YIELD.model }),
            ...ownLabels,
            ...right,
          ]
          const crowded = [
            muted("idle", { text: "", rank: STATUS_YIELD.phase }),
            muted("repo", { text: "", rank: STATUS_YIELD.cwd }),
            muted("Claude Sonnet 5.5 (anthropic)", {
              text: "Sonnet 5.5",
              rank: STATUS_YIELD.model,
            }),
            muted("high"),
            ...ownLabels,
            muted("main", { text: "", rank: STATUS_YIELD.model + 0.5 }),
            muted("3 files +5 -0", { text: "+5 -0", rank: STATUS_YIELD.cwd + 0.5 }),
            ...right,
          ]
          let labels = plain
          if (host === "crowded") labels = crowded
          return <StatusRow labels={labels} rightLabels={right.length} />
        },
        { width, height: 4 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("$0.002"), "status row")
      return frame.split("\n").find((line) => line.includes("$0.002")) ?? ""
    })

  it.scopedLive("the way back draws its key bright, as every hint does", () =>
    Effect.gen(function* () {
      const labels = yield* childLabels("explore")
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          const { theme } = useTheme()
          colors = Option.some(theme)
          const row = labels.map((item) => ({
            ...item,
            color: resolveThemeColor(theme, item.color),
          }))
          return <StatusRow labels={row} />
        },
        { width: 100, height: 4 },
      )
      yield* waitForFrame(setup, (next) => next.includes("← sessions"), "status row")
      const theme = Option.getOrThrow(colors)
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text === "←")?.fg.equals(theme.text)).toBe(true)
      expect(spans.find((span) => span.text.includes("sessions"))?.fg.equals(theme.textMuted)).toBe(
        true,
      )
    }).pipe(Effect.timeout("8 seconds")),
  )

  // The child label never costs the reader the way back or the cwd: at each
  // width they show as on the same row without it.
  for (const width of [100, 60, 40]) {
    for (const host of ["plain", "crowded"] as const) {
      it.scopedLive(`the child label keeps the way back and the cwd: ${host} row, ${width}`, () =>
        Effect.gen(function* () {
          const labels = yield* childLabels(
            "Check the greeting files (debug tools) and report back",
          )
          const withChild = yield* statusRowAt(width, host, labels)
          const hintOnly = yield* statusRowAt(width, host, labels.slice(1))
          const bare = yield* statusRowAt(width, host, [])
          expect(withChild.includes("← sessions")).toBe(hintOnly.includes("← sessions"))
          expect(withChild.includes("repo")).toBe(bare.includes("repo"))
          // At 100 columns a plain row has room for all three, the name cut at a word.
          if (width === 100 && host === "plain") {
            expect(withChild).toContain(
              "repo · Claude Sonnet 5.5 · ↳ child Check the… · ← sessions",
            )
          }
        }).pipe(Effect.timeout("8 seconds")),
      )
    }
  }
})

describe("agents pane counts and detail", () => {
  it.live("a working loop names the turn it is on, not finished turns and time", () =>
    Effect.sync(() => {
      const detail = (
        status: ExtensionAgentDetail["status"],
        turns: number,
      ): ExtensionAgentDetail => ({
        status,
        model: Option.some("anthropic/claude-sonnet-5"),
        turns,
        costUsd: 0.028,
        durationMs: 0,
        omittedMessages: 0,
        effort: Option.none(),
        firstPrompt: Option.none(),
        lastAnswer: Option.none(),
      })
      expect(detailLabel(Option.some(detail("Running", 0)))).toBe(
        "claude-sonnet-5  ·  turn 1 running  ·  $0.03",
      )
      expect(detailLabel(Option.some(detail("Idle", 2)))).toContain("2 turns  ·  $0.03")
    }),
  )
})

describe("idle middle parent", () => {
  // main → A → B. A started B and its own turn ended; only B works. Each row
  // sits in its own state's section, so B is a root of the running section.
  const nested: ReadonlyArray<AgentRowEntry> = [
    { ...child("b", "running", "a"), depth: 0 },
    { ...root("main", "idle"), name: "main" },
    { ...child("a", "idle", "main"), depth: 1 },
  ]
  const controllerOver = (open: () => boolean) => ({
    rows: () => nested,
    current: () => ({ sessionId: SessionId.make("main"), branchId: BranchId.make("main-branch") }),
    error: () => Option.none(),
    loading: () => false,
    refresh: () => {},
    reload: () => {},
    detail: () => Option.none(),
    select: () => {},
    done: () => [],
    open,
  })

  it.scopedLive("the tray lists only the grandchild that works", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => (
        <SubagentTray place={PLACE} controller={controllerOver(() => false)} />
      ))
      const frame = yield* waitForFrame(setup, (next) => next.includes("b task"), "tray")
      expect(frame).toContain("delegate: b task")
      expect(frame).not.toContain("a task")
    }),
  )

  it.scopedLive("the pane counts it idle in its title, its section and its glyph", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <AgentsPane
            place={PLACE}
            open={true}
            controller={controllerOver(() => true)}
            onSelect={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        ),
        { width: 100, height: 20 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("Sessions ·"), "pane")
      expect(frame).toContain("Sessions · 1 running · 2 idle")
      expect(frame).toContain("Running (1)")
      expect(frame).toContain("Idle (2)")
      // An idle loop draws the ring; only the working one pulses.
      const lineOf = (name: string) => frame.split("\n").find((line) => line.includes(name)) ?? ""
      expect(lineOf("delegate: a task")).toContain("○ delegate: a task")
      expect(lineOf("delegate: b task")).not.toContain("○ delegate: b task")
    }),
  )
})

describe("thread rows", () => {
  // first → second → third: one handoff chain, listed as one row on its newest session.
  const members = ["first", "second", "third"].map((id) => SessionId.make(id))
  const thread: AgentRowEntry = {
    ...root("third", "idle"),
    name: "fix auth refresh",
    sideThread: true,
    parentSessionId: SessionId.make("starter"),
    sessions: members,
  }
  const controllerOver = (listed: ReadonlyArray<AgentRowEntry>, current: string) => ({
    rows: () => listed,
    current: () => ({ sessionId: SessionId.make(current), branchId: BranchId.make("any") }),
    error: () => Option.none(),
    loading: () => false,
    refresh: () => {},
    reload: () => {},
    detail: () => Option.none(),
    select: () => {},
    done: () => [],
    open: () => true,
  })
  const paneAt = (listed: ReadonlyArray<AgentRowEntry>, current: string, width: number) =>
    renderScoped(
      () => (
        <AgentsPane
          place={PLACE}
          open={true}
          controller={controllerOver(listed, current)}
          onSelect={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      ),
      { width, height: 20 },
    )

  it.scopedLive(
    "a thread's row counts its sessions, and a narrow pane drops the side-thread mark first",
    () =>
      Effect.gen(function* () {
        // Wide enough that the list beside the details column keeps 80 columns.
        const wide = yield* paneAt([thread], "elsewhere", 140)
        const wideFrame = yield* waitForFrame(
          wide,
          (next) => next.includes("fix auth"),
          "wide pane",
        )
        // The list row, under the details column's name line on the filter row.
        const wideRow = wideFrame.split("\n").findLast((line) => line.includes("fix auth")) ?? ""
        expect(wideRow).toContain("side thread  3 sessions")

        const narrow = yield* paneAt([thread], "elsewhere", 60)
        const narrowFrame = yield* waitForFrame(
          narrow,
          (next) => next.includes("fix auth"),
          "narrow pane",
        )
        const narrowRow = narrowFrame.split("\n").find((line) => line.includes("fix auth")) ?? ""
        expect(narrowRow).toContain("3 sessions")
        expect(narrowRow).not.toContain("side thread")
      }),
  )

  it.scopedLive("the shell on an older session of a thread finds itself on the thread's row", () =>
    Effect.gen(function* () {
      const setup = yield* paneAt([root("other", "idle"), thread], "second", 100)
      const frame = yield* waitForFrame(setup, (next) => next.includes("fix auth"), "pane")
      const lineOf = (text: string) => frame.split("\n").find((line) => line.includes(text)) ?? ""
      expect(lineOf("fix auth")).toContain("› ")
      expect(lineOf("other")).not.toContain("› ")
    }),
  )

  it.scopedLive(
    "the tray of an older session lists the work its thread's newer session started",
    () =>
      Effect.gen(function* () {
        const listed = [thread, child("worker", "running", "third")]
        const setup = yield* renderScoped(() => (
          <SubagentTray
            place={PLACE}
            controller={{ ...controllerOver(listed, "first"), open: () => false }}
          />
        ))
        const frame = yield* waitForFrame(setup, (next) => next.includes("worker task"), "tray")
        expect(frame).toContain("delegate: worker task")
        expect(frame).not.toContain("fix auth")
      }),
  )

  it.scopedLive(
    "the tray of a handoff lists the work the session it continues started, by its real parent",
    () =>
      Effect.gen(function* () {
        // `first` spawned `worker`, then handed off to `third`: the worker's
        // parent stays `first`, whose thread's row is `third`'s.
        const listed = [thread, child("worker", "running", "first")]
        const setup = yield* renderScoped(() => (
          <SubagentTray
            place={PLACE}
            controller={{ ...controllerOver(listed, "third"), open: () => false }}
          />
        ))
        const frame = yield* waitForFrame(setup, (next) => next.includes("worker task"), "tray")
        expect(frame).toContain("delegate: worker task")
      }),
  )

  it.scopedLive(
    "a second Ctrl+X on a thread's row deletes each of its sessions, newest first",
    () =>
      Effect.gen(function* () {
        const deleted: Array<string> = []
        const reply = { rows: [thread] }
        const runtime = makeClientExtensionRuntime({
          transport: {
            ...makeClientTestTransport({ requestReply: reply }),
            client: createMockClient({
              extension: { request: () => Effect.succeed(reply) },
              session: {
                delete: (input: { readonly sessionId: string }) =>
                  Effect.sync(() => {
                    deleted.push(input.sessionId)
                  }),
              },
            }),
          },
        })
        const contributions = yield* runClientExtensionSetup(runtime, agentsExtension)
        const commands = contributions.commands ?? []
        const pane = Option.getOrThrow(
          Option.fromUndefinedOr(contributions.widgets?.find((w) => w.id === "agents.pane")),
        )
        const Session = () => {
          const command = useCommand()
          useScopedKeyboard((event) => command.handleKeybind(event, commands, true))
          return <pane.component />
        }
        const setup = yield* renderScoped(() => <Session />, { width: 120, height: 20 })
        setup.mockInput.pressArrow("left")
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("fix auth"),
          "the pane lists the thread",
        )

        setup.mockInput.pressKey("x", { ctrl: true })
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("delete this thread's 3 sessions and their children"),
          "armed",
        )
        setup.mockInput.pressKey("x", { ctrl: true })
        yield* waitUntil(() => deleted.length === 3, "each session deleted")
        expect(deleted).toEqual(["third", "second", "first"])
        yield* Effect.promise(() => runtime.dispose())
      }),
  )
})

describe("done threads", () => {
  const starter = { sessionId: SessionId.make("starter"), branchId: BranchId.make("starter-b") }
  const threadRow = (id: string, section: AgentRowEntry["section"]): AgentRowEntry => ({
    ...root(id, section),
    name: `${id} notes`,
    sideThread: true,
    parentSessionId: starter.sessionId,
  })

  /** The gate a test holds tray reads on. */
  interface ReadGate {
    gate: Option.Option<Deferred.Deferred<void>>
  }

  /**
   * A controller over a listing the test changes, with the shell on `here()`.
   * While `held` has a gate, a read waits on it, then answers the listing as
   * it is when the gate opens.
   */
  const controllerOver = (
    listed: (input: ListAgentsInput) => ReadonlyArray<AgentRowEntry>,
    here: () => RowKeyOf,
    held: ReadGate = { gate: Option.none() },
  ) =>
    Effect.gen(function* () {
      const pulses = new Set<
        (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void
      >()
      let listings = 0
      const clock = yield* TestClock.make()
      const controller = yield* provideClientServices(
        makeAgentsController(
          (input) =>
            Effect.sync(() => {
              listings += 1
              return held.gate
            }).pipe(
              Effect.flatMap(
                Option.match({ onNone: () => Effect.void, onSome: (gate) => Deferred.await(gate) }),
              ),
              Effect.map(() => listed(input)),
            ),
          () => Effect.succeed(detail(1)),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
        {
          currentSession: here,
          transport: {
            ...makeClientTestTransport({ currentSession: here }),
            onExtensionStateChanged: (cb) => {
              pulses.add(cb)
              return () => {
                pulses.delete(cb)
              }
            },
          },
        },
      )
      /** One read under `query` (none by default), awaited to its reply. */
      const read = (label: string, query = "") =>
        Effect.gen(function* () {
          const before = listings
          controller.refresh(query)
          yield* waitUntil(() => listings > before && !controller.loading(), label)
        })
      const pulse = (extensionId: string) => {
        for (const cb of pulses) cb({ ...here(), extensionId })
      }
      return { controller, read, pulse, listings: () => listings }
    })
  type RowKeyOf = { readonly sessionId: SessionId; readonly branchId: BranchId }

  it.scopedLive(
    "a thread seen running that goes idle while the shell is elsewhere is done until opened",
    () =>
      Effect.gen(function* () {
        let section: AgentRowEntry["section"] = "running"
        let here: RowKeyOf = starter
        const { controller, read } = yield* controllerOver(
          () => [threadRow("notes", section)],
          () => here,
        )
        yield* read("running")
        expect(controller.done()).toEqual([])

        section = "idle"
        yield* read("idle")
        expect(controller.done().map((row) => row.sessionId)).toEqual([SessionId.make("notes")])
        // Later listings keep it until the reader opens it.
        yield* read("idle again")
        expect(controller.done()).toHaveLength(1)

        here = { sessionId: SessionId.make("notes"), branchId: BranchId.make("notes-branch") }
        yield* read("opened")
        expect(controller.done()).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a thread the reader watched finish from inside it is not done back at its starter",
    () =>
      Effect.gen(function* () {
        let section: AgentRowEntry["section"] = "running"
        let here: RowKeyOf = starter
        const { controller, read } = yield* controllerOver(
          () => [threadRow("notes", section)],
          () => here,
        )
        yield* read("running, seen from the starter")
        // The reader opens the thread while it runs and sees it finish there.
        here = { sessionId: SessionId.make("notes"), branchId: BranchId.make("notes-branch") }
        yield* read("running, seen inside")
        section = "idle"
        yield* read("idle, seen inside")
        here = starter
        yield* read("back at the starter")
        expect(controller.done()).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a delegate child gets no done row, and a thread that runs again leaves done", () =>
    Effect.gen(function* () {
      let section: AgentRowEntry["section"] = "running"
      const { controller, read } = yield* controllerOver(
        () => [{ ...threadRow("child", section), delegate: true }, threadRow("again", section)],
        () => starter,
      )
      yield* read("running")
      section = "idle"
      yield* read("idle")
      expect(controller.done().map((row) => row.sessionId)).toEqual([SessionId.make("again")])
      section = "running"
      yield* read("running again")
      expect(controller.done()).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )

  /** `notes` as one thread over `sessions`, keyed by its first session. */
  const handedOff = (
    sessions: ReadonlyArray<string>,
    section: AgentRowEntry["section"],
  ): AgentRowEntry => {
    const newest = sessions.at(-1) ?? "notes"
    const entry = { ...threadRow(newest, section), thread: SessionId.make(sessions[0] ?? newest) }
    if (sessions.length === 1) return entry
    return { ...entry, sessions: sessions.map((id) => SessionId.make(id)) }
  }

  it.scopedLive(
    "a thread is done by its key across a handoff, and its next session's turn clears it",
    () =>
      Effect.gen(function* () {
        let listed = [handedOff(["t1"], "running")]
        const { controller, read } = yield* controllerOver(
          () => listed,
          () => starter,
        )
        yield* read("t1 runs")
        // The turn ended on a handoff: the row moves to t2, which is idle.
        listed = [handedOff(["t1", "t2"], "idle")]
        yield* read("t2 idle")
        expect(controller.done().map((row) => row.sessionId)).toEqual([SessionId.make("t2")])
        // A third session of the thread runs: the thread is not done.
        listed = [handedOff(["t1", "t2", "t3"], "running")]
        yield* read("t3 runs")
        expect(controller.done()).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a deleted thread leaves done when an unfiltered listing of its root lacks it, never by a filtered one",
    () =>
      Effect.gen(function* () {
        let listed = [threadRow("notes", "running")]
        const { controller, read } = yield* controllerOver(
          () => listed,
          () => starter,
        )
        yield* read("running")
        listed = [threadRow("notes", "idle")]
        yield* read("idle")
        expect(controller.done()).toHaveLength(1)
        // A filter that does not match the thread proves nothing about it.
        listed = []
        yield* read("filtered", "other words")
        listed = [threadRow("notes", "idle")]
        yield* read("idle again")
        expect(controller.done()).toHaveLength(1)
        // The thread is deleted: the root's whole listing no longer holds it.
        listed = []
        yield* read("deleted")
        listed = [threadRow("notes", "idle")]
        yield* read("a row with its id again")
        expect(controller.done()).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "done rows belong to the shell's thread: an unrelated session shows none, and coming back shows them",
    () =>
      Effect.gen(function* () {
        const elsewhere = { sessionId: SessionId.make("unrelated"), branchId: BranchId.make("u") }
        let here: RowKeyOf = starter
        let section: AgentRowEntry["section"] = "running"
        const { controller, read } = yield* controllerOver(
          (input) => {
            if (input.root === elsewhere.sessionId) return [root("unrelated", "idle")]
            return [threadRow("notes", section)]
          },
          () => here,
        )
        yield* read("running")
        section = "idle"
        yield* read("idle")
        expect(controller.done()).toHaveLength(1)
        here = elsewhere
        yield* read("unrelated")
        expect(controller.done()).toEqual([])
        here = starter
        yield* read("back")
        expect(controller.done().map((row) => row.sessionId)).toEqual([SessionId.make("notes")])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a reply the shell left before it landed changes no done row", () =>
    Effect.gen(function* () {
      // `starter` handed off to `next`: one thread, whose row is `next`'s.
      const own: AgentRowEntry = {
        ...root("next", "idle"),
        thread: starter.sessionId,
        sessions: [starter.sessionId, SessionId.make("next")],
      }
      const next = { sessionId: SessionId.make("next"), branchId: BranchId.make("next-b") }
      let here: RowKeyOf = starter
      let section: AgentRowEntry["section"] = "running"
      const held: ReadGate = { gate: Option.none() }
      const { controller, read, listings } = yield* controllerOver(
        () => [own, threadRow("notes", section)],
        () => here,
        held,
      )
      yield* read("running")
      // The next read is out when the shell moves to the thread's next session.
      const gate = yield* Deferred.make<void>()
      held.gate = Option.some(gate)
      const before = listings()
      controller.refresh("")
      yield* waitUntil(() => listings() > before, "the read is out")
      here = next
      section = "idle"
      yield* Deferred.done(gate, Exit.void)
      yield* waitUntil(() => !controller.loading(), "the reply lands")
      // The reply was for `starter`; the shell is on `next`. It is dropped.
      expect(controller.done()).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a session-tools pulse re-reads the tray, so a started thread shows at once", () =>
    Effect.gen(function* () {
      const { pulse, listings } = yield* controllerOver(
        () => [],
        () => starter,
      )
      const before = listings()
      pulse(SESSION_TOOLS_EXTENSION_ID)
      yield* waitUntil(() => listings() > before, "pulse read")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("done rows follow the working rows inside the cap, and the rest are counted", () =>
    Effect.sync(() => {
      const running = ["a", "b"].map((id) => child(id, "running", "root"))
      const done = ["x", "y"].map((id) => threadRow(id, "idle"))
      const lines = trayLines(running, 80, done, PLACE)
      expect(lines.map((line) => line.text)).toEqual([
        "delegate: a task",
        "delegate: b task",
        "x notes",
        "+1 more",
      ])
      // The glyph is the state: the pulse for a running child, `◆` for a done thread.
      expect(lines.map((line) => line.mark)).toEqual(["running", "running", "done", "none"])
      expect(trayLines([], 80, done, PLACE).map((line) => line.mark)).toEqual(["done", "done"])
    }),
  )

  it.scopedLive("the tray shows a done thread, and hides it while the shell is on it", () =>
    Effect.gen(function* () {
      const [here, setHere] = createSignal<RowKeyOf>(starter)
      const finished = threadRow("release", "idle")
      const setup = yield* renderScoped(
        () => (
          <SubagentTray
            place={PLACE}
            controller={{
              rows: () => [finished],
              current: here,
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [finished],
              open: () => false,
            }}
          />
        ),
        { width: 80, height: 10 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("release notes"), "done row")
      expect(frame).toContain("◆ release notes")
      expect(frame).not.toContain("done ·")
      expect(frame).toContain("← sessions")
      setHere({ sessionId: finished.sessionId, branchId: finished.branchId })
      yield* waitForFrame(setup, (next) => !next.includes("release notes"), "opened thread")
    }),
  )
})

describe("trayLines", () => {
  /** Where the TUI launched: a call's path reads against it, as the live line's does. */
  const place = { cwd: "/work", home: "/home/me" }
  it.live("one line per running child by name, no state word, the rest counted", () =>
    Effect.sync(() => {
      const running = ["a", "b", "c", "d", "e"].map((id) => child(id, "running", "root"))
      const lines = trayLines(running, 60, [], place)
      expect(lines.map((line) => line.text)).toEqual([
        "delegate: a task",
        "delegate: b task",
        "delegate: c task",
        "+2 more",
      ])
      expect(lines.map((line) => line.mark)).toEqual(["running", "running", "running", "none"])
      expect(trayLines(running.slice(0, 1), 12, [], place)[0]?.text).toBe("delegate: a…")
    }),
  )
  it.live("children keep their start order while their updates reorder the listing", () =>
    Effect.sync(() => {
      const started = (id: string, createdAt: number, updatedAt: number) => ({
        ...child(id, "running", "root"),
        createdAt,
        updatedAt,
      })
      // Two polls of the same three children; each step bumps `updatedAt`.
      const first = [started("b", 2, 30), started("a", 1, 20), started("c", 3, 10)]
      const second = [started("c", 3, 50), started("b", 2, 40), started("a", 1, 35)]
      const expected = ["delegate: a task", "delegate: b task", "delegate: c task"]
      expect(trayLines(first, 60, [], place).map((line) => line.text)).toEqual(expected)
      expect(trayLines(second, 60, [], place).map((line) => line.text)).toEqual(expected)
    }),
  )
  it.live("a running child's call reads in the live line's words", () =>
    Effect.sync(() => {
      const busy = (runningCall: NonNullable<AgentRowEntry["runningCall"]>) =>
        trayLines([{ ...child("a", "running", "root"), runningCall }], 80, [], place)[0]?.text
      expect(busy({ tool: "bash", input: { command: "bun test" } })).toBe(
        "delegate: a task · Running bun test",
      )
      expect(busy({ tool: "read", input: { path: "/work/src/loader.ts" } })).toBe(
        "delegate: a task · Reading src/loader.ts",
      )
      // A cell reads in its source's verbs, never its code.
      expect(
        busy({
          tool: "cell",
          input: {
            code: "await Promise.all([tools.read({path:'a.ts'}), tools.read({path:'b.ts'})])",
          },
        }),
      ).toBe("delegate: a task · Reading 2 files")
    }),
  )
  it.live("with no call running, the child's last streamed line shows", () =>
    Effect.sync(() => {
      const talking = { ...child("a", "running", "root"), activity: "Checking the tests" }
      expect(trayLines([talking], 60, [], place)[0]?.text).toBe(
        "delegate: a task · Checking the tests",
      )
      // A running call wins over the line streamed before it.
      const both = { ...talking, runningCall: { tool: "bash", input: { command: "bun test" } } }
      expect(trayLines([both], 60, [], place)[0]?.text).toBe("delegate: a task · Running bun test")
    }),
  )
  it.live("a long task name leaves room for what the child is doing", () =>
    Effect.sync(() => {
      const busy = {
        ...child("a", "running", "root"),
        name: "Run this shell command exactly: sleep 5; echo step one; sleep 40; echo finished",
        runningCall: { tool: "bash", input: { command: "sleep 40" } },
      }
      for (const width of [100, 60, 40]) {
        const text = trayLines([busy], width, [], place)[0]?.text ?? ""
        expect(text.endsWith(" · Running sleep 40")).toBe(true)
        expect(text.startsWith("Run this")).toBe(true)
        expect(text.length).toBeLessThanOrEqual(width)
      }
    }),
  )
})

describe("Subagent tray", () => {
  it.scopedLive("lists the running child and hides when the pane opens", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(false)
      const refreshes: Array<string> = []

      // As in the app: the dock wraps the footer, and the open agents pane
      // mounts a `PickerFrame` in it.
      const setup = yield* renderScoped(() => (
        <DockProvider>
          <SubagentTray
            place={PLACE}
            controller={{
              rows: () => rows,
              current: () => ({
                sessionId: SessionId.make("root"),
                branchId: BranchId.make("root-branch"),
              }),
              error: () => Option.none(),
              loading: () => false,
              refresh: (query) => {
                refreshes.push(query)
              },
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open,
            }}
          />
          <Show when={open()}>
            <PickerFrame title="PANE" keys={[]} error={Option.none()}>
              <box />
            </PickerFrame>
          </Show>
        </DockProvider>
      ))

      yield* waitForFrame(setup, () => renderFrame(setup).includes("child-a task"), "tray")
      const frame = renderFrame(setup)
      expect(frame).toMatch(/[◇◈◆] delegate: child-a task/)
      expect(frame).not.toContain("working")
      expect(frame).not.toContain("child-b")
      expect(frame).not.toContain("idle")
      expect(frame).toContain("← sessions")
      // The controller owns reads; mounting its tray does not duplicate them.
      expect(refreshes).toEqual([])

      setOpen(true)
      yield* waitForFrame(setup, () => !renderFrame(setup).includes("child-a task"), "tray hidden")
    }),
  )

  it.scopedLive("a running child is one line at 100, 60 and 40 columns: pulse, name, call", () =>
    Effect.gen(function* () {
      const busy: AgentRowEntry = {
        ...child("busy", "running", "root"),
        name: "delegate: Check docs/architecture against the retry code",
        runningCall: { tool: "read", input: { path: "/work/ARCHITECTURE.md" } },
      }
      for (const width of [100, 60, 40]) {
        let names = () => RGBA.fromInts(0, 0, 0, 0)
        const setup = yield* renderScoped(
          () => {
            const { theme } = useTheme()
            names = () => theme.info
            return (
              <SubagentTray
                place={PLACE}
                controller={{
                  rows: () => [root("root", "idle"), busy],
                  current: () => ({
                    sessionId: SessionId.make("root"),
                    branchId: BranchId.make("root-branch"),
                  }),
                  error: () => Option.none(),
                  loading: () => false,
                  refresh: () => {},
                  reload: () => {},
                  detail: () => Option.none(),
                  select: () => {},
                  done: () => [],
                  open: () => false,
                }}
              />
            )
          },
          { width, height: 6 },
        )
        const frame = yield* waitForFrame(setup, (next) => next.includes("← sessions"), "tray")
        const line = frame.split("\n").find((value) => value.includes("← sessions")) ?? ""
        expect(line).toMatch(/^ ?[◇◈◆] dele/)
        // The child's name takes the names' colour, as Codex draws a nickname; the call stays muted.
        const spans = setup.captureSpans().lines.flatMap((spans) => spans.spans)
        // A span is a run of one colour: the pulse may share the names' colour, and its span.
        const name = spans.find((span) => span.text.includes("dele"))
        expect(name?.fg.equals(names())).toBe(true)
        expect(name?.text).not.toContain("Reading")
        const call = spans.find((span) => span.text.includes("Reading"))
        expect(call?.fg.equals(names())).toBe(false)
        // The call keeps up to half the row; the name is cut to the rest.
        expect(line).toContain("· Reading")
        if (width === 100) expect(line).toContain("· Reading ARCHITECTURE.md")
        expect(line).toContain("← sessions")
        expect(line).not.toContain("working")
        expect(line.trimEnd().length).toBeLessThanOrEqual(width)
      }
    }),
  )

  // `bun run gamut wait` reads the pane tail: a working child's row must read
  // busy, and a done thread's row idle. The rows come from this renderer, so
  // a change to the tray turns this red rather than the live check hanging.
  it.scopedLive("the gamut wait reads a running child's row as busy and a done row as idle", () =>
    Effect.gen(function* () {
      const tray = (running: ReadonlyArray<AgentRowEntry>, done: ReadonlyArray<AgentRowEntry>) =>
        renderScoped(
          () => (
            <SubagentTray
              place={PLACE}
              controller={{
                rows: () => [root("root", "idle"), ...running],
                current: () => ({
                  sessionId: SessionId.make("root"),
                  branchId: BranchId.make("root-branch"),
                }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                done: () => done,
                open: () => false,
              }}
            />
          ),
          { width: 80, height: 6 },
        )
      const busy = yield* tray([child("busy", "running", "root")], [])
      // `◆` is a pulse frame and the done glyph alike, so the wait reads it as idle.
      for (const pulse of ["◇", "◈"]) {
        const frame = yield* waitForFrame(
          busy,
          (next) => next.includes(`${pulse} delegate: busy task`),
          `pulse ${pulse}`,
        )
        expect(paneShowsWorkingChild(frame)).toBe(true)
      }
      const thread: AgentRowEntry = {
        ...root("release", "idle"),
        name: "release notes",
        sideThread: true,
        parentSessionId: SessionId.make("root"),
      }
      const done = yield* tray([], [thread])
      const frame = yield* waitForFrame(done, (next) => next.includes("◆ release notes"), "done")
      expect(paneShowsWorkingChild(frame)).toBe(false)
    }),
  )

  it.scopedLive("the hint stays on the row when a child's name is wide", () =>
    Effect.gen(function* () {
      const wide = [
        root("root", "idle"),
        { ...child("wide", "running", "root"), name: "日本語のタスク" },
      ]
      const setup = yield* renderScoped(
        () => (
          <SubagentTray
            place={PLACE}
            controller={{
              rows: () => wide,
              current: () => ({
                sessionId: SessionId.make("root"),
                branchId: BranchId.make("root-branch"),
              }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              done: () => [],
              open: () => false,
            }}
          />
        ),
        { width: 80, height: 10 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("日本語"), "wide tray")
      // Padding counts display columns: each of these characters takes two.
      expect(frame).toContain("← sessions")
    }),
  )

  it.scopedLive("stays hidden for a session whose children are all idle or inactive", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => (
        <SubagentTray
          place={PLACE}
          controller={{
            rows: () => rows,
            current: () => ({ sessionId: SessionId.make("child-b"), branchId: BranchId.make("b") }),
            error: () => Option.none(),
            loading: () => false,
            refresh: () => {},
            reload: () => {},
            detail: () => Option.none(),
            select: () => {},
            done: () => [],
            open: () => false,
          }}
        />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("task")
      expect(renderFrame(setup)).not.toContain("agents")
    }),
  )
})

// ── pane stale reply ────────────────────────────────────────────────────────

/**
 * The agents pane must not write a previous session's rows, and must not write an
 * older query's rows either.
 *
 * The pane refetches across a session switch — on `current()` changing plus a
 * 2 s poll — so a reply can land after the shell has already moved. The key the fetch was made for
 * is re-read when it lands; a reply for any other key is dropped.
 *
 * The filter fires one fetch per keystroke, so replies also race each other
 * within one session. Only the newest refresh may write, and every reply that
 * reaches the query clears the load state, even the ones it drops.
 */

const key = (id: string) => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
})

describe("Agents controller across a session switch", () => {
  it.scopedLive("drops a reply that lands after the shell moved to another session", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      // The shell starts on "first"; the test moves it while the fetch is out.
      let active = key("first")

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      // Fetch for "first" goes out, then the shell switches to "second".
      active = key("second")

      // The in-flight reply carries the previous session's rows.
      yield* Deferred.succeed(gate, [row("first")])
      yield* Effect.yieldNow

      expect(controller.rows()).toEqual([])
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("keeps the newest filter's rows when an older one replies last", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const second = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const gates = new Map([
        ["a", first],
        ["ab", second],
      ])

      const active = key("only")
      const controller = yield* provideClientServices(
        makeAgentsController(
          ({ query }) =>
            Option.match(Option.fromUndefinedOr(gates.get(query ?? "")), {
              onNone: () => Effect.succeed([]),
              onSome: (gate) => Deferred.await(gate),
            }),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      // One fetch per keystroke; the shorter query is still out when the
      // longer one replies.
      controller.refresh("a")
      controller.refresh("ab")

      yield* Deferred.succeed(second, [row("ab-match")])
      yield* Effect.yieldNow
      yield* Deferred.succeed(first, [row("a-match")])
      yield* Effect.yieldNow

      expect(controller.rows().map((entry) => String(entry.sessionId))).toEqual(["ab-match"])
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("stops loading even when the reply is for the session the shell left", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      let active = key("first")
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      expect(controller.loading()).toBe(true)
      active = key("second")

      yield* Deferred.succeed(gate, [row("first")])
      yield* Effect.yieldNow

      // The rows are dropped, but the pane must not draw "loading" forever.
      expect(controller.rows()).toEqual([])
      expect(controller.loading()).toBe(false)
    }).pipe(Effect.timeout("20 seconds")),
  )
})

// ── descendant activity ─────────────────────────────────────────────────────

describe("Descendant activity", () => {
  const parent = key("activity-parent")
  const working = (id: string, parentSessionId = parent.sessionId): AgentRowEntry => ({
    ...row(id),
    parentSessionId,
    section: "running",
    status: "Running",
  })
  const over = (
    fetch: (
      input: ListAgentsInput,
    ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
    here: () => typeof parent = () => parent,
    pane = makePaneSlot(),
    clock?: Clock.Clock,
    transport = makeClientTestTransport({ currentSession: here }),
  ) =>
    Effect.gen(function* () {
      const controllerClock = yield* Clock.Clock
      const scope = yield* Scope.Scope
      const cast = createMockRuntime().cast
      const cleanups: Array<() => void> = []
      const context = yield* Layer.buildWithScope(
        makeClientContextLayer(
          testClientContextDeps({
            transport,
            activity: () => ({ sessionId: here().sessionId, state: "idle" }),
            shell: {
              pane,
              cast: (effect) => {
                cast(Effect.forkIn(effect, scope))
              },
            },
            lifecycle: { addCleanup: (cleanup) => cleanups.push(cleanup) },
          }),
        ),
        scope,
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const cleanup of cleanups) cleanup()
        }),
      )
      return yield* Effect.gen(function* () {
        const { activity } = yield* ClientContext
        const controller = yield* makeAgentsController(fetch, () => Effect.succeed(detail(0))).pipe(
          Effect.provideService(
            Clock.Clock,
            Option.getOrElse(Option.fromUndefinedOr(clock), () => controllerClock),
          ),
        )
        return { controller, activity }
      }).pipe(Effect.provideContext(context))
    })
  const settle = (controller: { readonly loading: () => boolean }) =>
    waitUntil(() => !controller.loading(), "listing settled")

  it.scopedLive(
    "BTW activity discovers new work after an empty or inactive tree stopped polling",
    () =>
      Effect.gen(function* () {
        for (const initial of [
          [],
          [{ ...row("stored", false), parentSessionId: parent.sessionId, section: "inactive" }],
        ] satisfies ReadonlyArray<ReadonlyArray<AgentRowEntry>>) {
          const clock = yield* TestClock.make()
          const pane = makePaneSlot()
          const pulses = new Set<
            Parameters<ReturnType<typeof makeClientTestTransport>["onExtensionStateChanged"]>[0]
          >()
          let listed: ReadonlyArray<AgentRowEntry> = initial
          const asked: Array<ListAgentsInput> = []
          const { controller, activity } = yield* over(
            (input) => {
              asked.push(input)
              return Effect.succeed(listed)
            },
            () => parent,
            pane,
            clock,
            {
              ...makeClientTestTransport({ currentSession: () => parent }),
              onExtensionStateChanged: (cb) => {
                pulses.add(cb)
                return () => {
                  pulses.delete(cb)
                }
              },
            },
          )
          yield* settle(controller)
          expect(activity.snapshot().state).toBe("idle")
          expect(pane.isOpen("agents.pane")).toBe(false)
          yield* clock.adjust("6 seconds")
          expect(asked).toEqual([{ query: "", root: parent.sessionId }])
          listed = [working("btw-child"), working("unrelated", SessionId.make("elsewhere"))]
          for (const cb of pulses) cb({ ...parent, extensionId: "@gent/unrelated" })
          expect(asked).toHaveLength(1)
          for (const cb of pulses) cb({ ...parent, extensionId: BTW_EXTENSION_ID })
          yield* settle(controller)
          expect(activity.snapshot().state).toBe("working")
          expect(asked).toEqual([
            { query: "", root: parent.sessionId },
            { query: "", root: parent.sessionId },
          ])
          // Stream pulses do not duplicate reads once the same child clock is active.
          for (let pulse = 0; pulse < 5; pulse++) {
            for (const cb of pulses) cb({ ...parent, extensionId: BTW_EXTENSION_ID })
          }
          expect(asked).toHaveLength(2)
          listed = [...listed, { ...working("asking-child"), status: "WaitingForInteraction" }]
          yield* clock.adjust("2 seconds")
          yield* settle(controller)
          expect(activity.snapshot().state).toBe("blocked")
          expect(asked).toHaveLength(3)
        }
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "without a tray, setup and identity changes read activity without user action",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const [here, setHere] = createSignal(parent)
        const asked: Array<ListAgentsInput> = []
        let listed: ReadonlyArray<AgentRowEntry> = [working("child")]
        const { controller, activity } = yield* over(
          (input) => {
            asked.push(input)
            return Effect.succeed(listed)
          },
          here,
          makePaneSlot(),
          clock,
        )
        yield* Effect.yieldNow
        expect(asked).toEqual([{ query: "", root: parent.sessionId }])
        expect(activity.snapshot().state).toBe("working")
        listed = []
        setHere({ ...parent, branchId: BranchId.make("changed-branch") })
        yield* settle(controller)
        expect(asked).toHaveLength(2)
        expect(activity.snapshot().state).toBe("idle")
        listed = [working("next-child", SessionId.make("changed-session"))]
        setHere(key("changed-session"))
        yield* settle(controller)
        expect(asked).toHaveLength(3)
        expect(activity.snapshot().state).toBe("working")
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "the existing clock repairs missing complete knowledge with no tray, then stops on an empty tree",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const pane = makePaneSlot()
        const asked: Array<ListAgentsInput> = []
        let failComplete = false
        const { controller, activity } = yield* over(
          (input) => {
            asked.push(input)
            if (failComplete && Predicate.isNotUndefined(input.root))
              return Effect.fail({ message: "complete read unavailable" })
            return Effect.succeed([])
          },
          () => parent,
          pane,
          clock,
        )
        yield* Effect.yieldNow
        expect(asked).toHaveLength(1)
        expect(activity.snapshot().state).toBe("idle")
        pane.open("agents.pane")
        failComplete = true
        controller.refresh("needle")
        yield* settle(controller)
        expect(asked).toHaveLength(3)
        expect(activity.snapshot().state).toBe("unknown")
        expect(controller.error()).toEqual(Option.none())
        pane.close("agents.pane")
        failComplete = false
        yield* clock.adjust("2 seconds")
        yield* settle(controller)
        expect(asked).toHaveLength(4)
        expect(asked[3]).toEqual({ query: "", root: parent.sessionId })
        expect(activity.snapshot().state).toBe("idle")
        yield* clock.adjust("6 seconds")
        expect(asked).toHaveLength(4)
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("a waiting descendant needs attention even while another descendant works", () =>
    Effect.gen(function* () {
      const { activity } = yield* over(() =>
        Effect.succeed([
          working("worker"),
          { ...working("asking"), status: "WaitingForInteraction" },
        ]),
      )
      yield* Effect.yieldNow
      expect(activity.snapshot().state).toBe("blocked")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("counts transitive children of older thread members, not unrelated loops", () =>
    Effect.gen(function* () {
      const root = {
        ...row("new-parent"),
        sessions: [parent.sessionId, SessionId.make("new-parent")],
        status: "Idle",
      }
      const child = {
        ...row("child-handoff"),
        parentSessionId: parent.sessionId,
        sessions: [SessionId.make("old-child"), SessionId.make("child-handoff")],
        status: "Idle",
        sideThread: true,
      }
      let rows = [
        root,
        child,
        working("btw-grandchild", SessionId.make("old-child")),
        working("unrelated", SessionId.make("elsewhere")),
      ]
      const { controller, activity } = yield* over(() => Effect.succeed(rows))
      controller.refresh("")
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("working")
      rows = [root, child, working("unrelated", SessionId.make("elsewhere"))]
      controller.reload()
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("idle")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "missing live status is unknown, while inactive rows and a complete empty tree are idle",
    () =>
      Effect.gen(function* () {
        let rows: ReadonlyArray<AgentRowEntry> = [
          { ...row("missing"), parentSessionId: parent.sessionId },
        ]
        const { controller, activity } = yield* over(() => Effect.succeed(rows))
        expect(activity.snapshot().state).toBe("unknown")
        controller.refresh("")
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("unknown")
        rows = [{ ...row("stored", false), parentSessionId: parent.sessionId, section: "inactive" }]
        controller.reload()
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("idle")
        rows = []
        controller.reload()
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("idle")
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("a filtered pane cannot hide a worker; only filtered reads ask twice", () =>
    Effect.gen(function* () {
      const asked: Array<ListAgentsInput> = []
      const pane = makePaneSlot()
      const { controller, activity } = yield* over(
        (input) => {
          asked.push(input)
          if (input.query === "hidden") return Effect.succeed([])
          return Effect.succeed([working("hidden-worker")])
        },
        () => parent,
        pane,
      )
      yield* settle(controller)
      expect(asked).toEqual([{ query: "", root: parent.sessionId }])
      pane.open("agents.pane")
      controller.refresh("")
      yield* settle(controller)
      expect(asked).toEqual([{ query: "", root: parent.sessionId }, { query: "" }])
      controller.refresh("hidden")
      yield* settle(controller)
      expect(controller.rows()).toEqual([])
      expect(activity.snapshot().state).toBe("working")
      expect(asked.slice(2)).toEqual([{ query: "hidden" }, { query: "", root: parent.sessionId }])
      controller.reload()
      yield* settle(controller)
      expect(asked.slice(4)).toEqual([{ query: "hidden" }, { query: "", root: parent.sessionId }])
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("failed pane and complete reads never turn missing children into idle", () =>
    Effect.gen(function* () {
      const pane = makePaneSlot()
      let failComplete = false
      let failPane = false
      const { controller, activity } = yield* over(
        (input) => {
          if (failPane || (failComplete && Predicate.isNotUndefined(input.root)))
            return Effect.fail({ message: "listing unavailable" })
          if (input.query === "filter") return Effect.succeed([])
          return Effect.succeed([working("child")])
        },
        () => parent,
        pane,
      )
      pane.open("agents.pane")
      controller.refresh("")
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("working")
      failComplete = true
      controller.refresh("filter")
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("unknown")
      failComplete = false
      controller.refresh("")
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("working")
      failPane = true
      controller.reload()
      yield* settle(controller)
      expect(activity.snapshot().state).toBe("unknown")
      expect(controller.error()).toEqual(Option.some("listing unavailable"))
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "filtered activity reads coalesce pulses and use the controller's existing poll clock",
    () =>
      Effect.gen(function* () {
        const pane = makePaneSlot()
        const clock = yield* TestClock.make()
        const complete = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
        const asked: Array<ListAgentsInput> = []
        const controller = yield* provideClientServices(
          makeAgentsController(
            (input) => {
              asked.push(input)
              if (asked.length === 1 || Predicate.isUndefined(input.root)) return Effect.succeed([])
              return Deferred.await(complete)
            },
            () => Effect.never,
          ).pipe(Effect.provideService(Clock.Clock, clock)),
          {
            currentSession: () => parent,
            shell: { pane },
          },
        )
        pane.open("agents.pane")
        controller.refresh("needle")
        yield* waitUntil(() => asked.length === 3, "complete read in flight")
        for (let pulse = 0; pulse < 5; pulse++) controller.reload()
        yield* clock.adjust("2 seconds")
        expect(asked).toHaveLength(3)
        yield* Deferred.succeed(complete, [working("hidden-worker")])
        yield* waitUntil(
          () => asked.length === 5 && !controller.loading(),
          "one queued pair settled",
        )
        expect(asked).toEqual([
          { query: "", root: parent.sessionId },
          { query: "needle" },
          { query: "", root: parent.sessionId },
          { query: "needle" },
          { query: "", root: parent.sessionId },
        ])
        yield* clock.adjust("2 seconds")
        yield* waitUntil(() => asked.length === 7 && !controller.loading(), "one poll pair settled")
        expect(asked.slice(5)).toEqual([{ query: "needle" }, { query: "", root: parent.sessionId }])
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "session and branch switches reject accepted data and replies still in flight",
    () =>
      Effect.gen(function* () {
        const [here, setHere] = createSignal(parent)
        let held = Option.none<Deferred.Deferred<ReadonlyArray<AgentRowEntry>>>()
        let reads = 0
        const { controller, activity } = yield* over(() => {
          reads++
          return Option.match(held, {
            onNone: () => Effect.succeed([working("child")]),
            onSome: Deferred.await,
          })
        }, here)
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("working")
        const old = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
        held = Option.some(old)
        controller.reload()
        expect(controller.loading()).toBe(true)
        const current = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
        held = Option.some(current)
        setHere({ ...parent, branchId: BranchId.make("another-branch") })
        expect(activity.snapshot().state).toBe("unknown")
        yield* Deferred.succeed(old, [working("stale")])
        yield* waitUntil(() => reads === 3, "replacement read starts automatically")
        expect(activity.snapshot().state).toBe("unknown")
        yield* Deferred.succeed(current, [working("child")])
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("working")
        const accepted = here()
        const returning = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
        held = Option.some(returning)
        setHere(key("another-session"))
        setHere(accepted)
        expect(activity.snapshot().state).toBe("unknown")
        held = Option.none()
        yield* Deferred.succeed(returning, [])
        yield* settle(controller)
        expect(activity.snapshot().state).toBe("working")
        setHere(key("another-session"))
        yield* settle(controller)
        expect(activity.snapshot()).toEqual({ sessionId: here().sessionId, state: "idle" })
      }).pipe(Effect.timeout("5 seconds")),
  )
})
