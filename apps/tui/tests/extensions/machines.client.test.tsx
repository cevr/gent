/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Array as Arr, Clock, DateTime, Effect, Option, Queue, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { createSignal } from "solid-js"
import {
  AgentEvent,
  CredentialSlot,
  EventEnvelope,
  type LaneReport,
  type ProviderLanes,
} from "@gent/core/protocol"
import { BranchId, ref, SessionId } from "@gent/core/extensions/api"
import { EventId } from "@gent/core/test-utils"
import { type MachineRunView, MachinesRpc } from "@gent/extensions/client"
import machinesExtension, {
  type BandData,
  bandRows,
  LanesBand,
} from "../../src/extensions/machines.client"
import { laneRows } from "../../src/utils"
import { textWidth } from "../../src/bun-adapter"
import { makeClientTestTransport, provideClientServices } from "../extension-test-harness-boundary"
import { createMockClient, renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame } from "../helpers-boundary"

// ── fixtures ────────────────────────────────────────────────────────────────

/** 2026-10-21 12:00 UTC: clock times below read in UTC. */
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const utc = DateTime.zoneMakeOffset(0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const window = (
  name: string,
  fields: Partial<ProviderLanes["accounts"][number]["windows"][number]>,
): ProviderLanes["accounts"][number]["windows"][number] => ({
  window: name,
  utilization: 0.4,
  resetAt: NOW + 2 * HOUR,
  readAt: NOW - MINUTE,
  rejected: false,
  samples: 6,
  outsideShare: 0,
  ...fields,
})

const DEFAULT = CredentialSlot.make("default")

/** Five runs of room on one account, two held: the 5h window binds, its rate fitted. */
const measured: LaneReport = {
  providers: [
    {
      provider: "anthropic",
      scope: [DEFAULT],
      accounts: [
        {
          slot: DEFAULT,
          // The weekly window comes first; the 5h one binds, since it carries fewer runs.
          windows: [
            window("7d", {
              resetAt: NOW + 3 * 24 * HOUR,
              fuelPerPct: 2_000_000,
              band: 0.2,
              sustainable: 9,
            }),
            window("5h", { fuelPerPct: 120_000, band: 0.08, outsideShare: 0.12, sustainable: 5.4 }),
          ],
          held: false,
          sustainable: 5.4,
        },
      ],
      capacity: 5,
      load: 2,
      fuelPerHour: 3_400_000,
      laneHours: 2,
      models: [],
    },
  ],
}

/** The 5h window refused at 13:47: no run starts until it resets. */
const spent: LaneReport = {
  providers: [
    {
      provider: "anthropic",
      scope: [DEFAULT],
      accounts: [
        {
          slot: DEFAULT,
          windows: [
            window("5h", {
              utilization: 1,
              resetAt: NOW + HOUR + 47 * MINUTE,
              rejected: true,
              sustainable: 0,
            }),
          ],
          held: true,
          sustainable: 0,
        },
      ],
      capacity: 0,
      load: 0,
      fuelPerHour: 3_400_000,
      laneHours: 0,
      models: [],
    },
  ],
}

/** A reading with no rate yet: gent cannot size the lanes. */
const unrated: LaneReport = {
  providers: [
    {
      provider: "anthropic",
      scope: [DEFAULT],
      accounts: [{ slot: DEFAULT, windows: [window("5h", {})], held: false }],
      load: 1,
      fuelPerHour: 3_400_000,
      laneHours: 0,
      models: [],
    },
  ],
}

const WORK = CredentialSlot.make("work")
const HOME = CredentialSlot.make("home")
const OLD = CredentialSlot.make("old")

/**
 * `measured`, with banked resets: default holds two that lapse at 15:00,
 * work one with no expiry and one lapsed a minute ago, home a lapsed one and
 * an empty one, and old, out of the pool, three with no expiry.
 */
const banked: LaneReport = {
  providers: measured.providers.map((lanes) => ({
    ...lanes,
    scope: [DEFAULT, WORK, HOME],
    accounts: [
      ...lanes.accounts.map((account) => ({
        ...account,
        resets: [{ count: 2, expiresAt: NOW + 3 * HOUR }],
      })),
      {
        slot: WORK,
        windows: [],
        held: false,
        resets: [{ count: 1 }, { count: 1, expiresAt: NOW - MINUTE }],
      },
      {
        slot: HOME,
        windows: [],
        held: false,
        resets: [{ count: 1, expiresAt: NOW - 1 }, { count: 0 }],
      },
      { slot: OLD, windows: [], held: false, resets: [{ count: 3 }] },
    ],
  })),
}

/** A run as `MachinesRpc.Runs` puts it on the wire, decoded by the request's own output schema. */
const decodeRuns = Schema.decodeUnknownSync(ref(MachinesRpc.Runs).output)

const run = (fields: Record<string, Schema.Json>): MachineRunView =>
  Option.getOrThrow(
    Arr.head(
      decodeRuns([
        {
          run: "run-0000000000000001",
          machine: "track",
          state: "implement",
          status: "running",
          visits: { implement: 2 },
          createdAt: NOW - 4 * MINUTE,
          ...fields,
        },
      ]),
    ),
  )

/** `measured` with the peer `peer` reports. */
const withPeer = (peer: NonNullable<LaneReport["peer"]>, report = measured): LaneReport => ({
  ...report,
  peer,
})

/** The peer `workbox`, its last line 12 s ago, two runs on this pool, both links up. */
const linked: NonNullable<LaneReport["peer"]> = {
  heard: { host: "workbox", at: NOW - 12_000 },
  runs: 2,
  silent: false,
  down: [],
}

const texts = (data: BandData, width: number) =>
  bandRows(data, NOW, width, utc).map((row) => `${row.glyph} ${row.text}`)

// ── rows ────────────────────────────────────────────────────────────────────

describe("the lanes band rows", () => {
  test("measured lanes name the free runs, the binding window's rate, its band and the outside share", () => {
    expect(laneRows(measured, NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%", state: "free" },
    ])
  })

  test("a narrow row drops the share, the band, the window and the provider, and keeps the free count", () => {
    const at = (width: number) => laneRows(measured, NOW, width, utc)[0]?.text
    expect(at(46)).toBe("lanes anthropic 3/5 free · 5h 120k/% ±8%")
    expect(at(38)).toBe("lanes anthropic 3/5 free · 5h 120k/%")
    expect(at(30)).toBe("lanes anthropic 3/5 free")
    expect(at(20)).toBe("lanes 3/5 free")
    expect(at(10)).toBe("3/5 free")
    for (const width of [46, 38, 30, 20, 10, 8]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
      expect(at(width)).toContain("3/5")
    }
  })

  test("no free lane names the clock its window resets at, at every width", () => {
    const at = (width: number) => laneRows(spent, NOW, width, utc)[0]
    expect(at(120)).toEqual({ text: "lanes anthropic 0 free · retry 13:47", state: "none" })
    expect(at(30)?.text).toBe("lanes 0 free · retry 13:47")
    expect(at(20)?.text).toBe("0 free · retry 13:47")
    expect(at(10)?.text).toBe("0 free")
  })

  test("the owner's Sabbath names its end first, at every width, and hides lanes unknown", () => {
    const end = Date.UTC(2026, 9, 22, 18, 9)
    const at = (report: LaneReport, width: number) =>
      laneRows({ ...report, sabbathEnd: end }, NOW, width, utc)
    expect(at(measured, 120)).toEqual([
      { text: "sabbath · no run starts until 2026-10-22 18:09", state: "none" },
      ...laneRows(measured, NOW, 120, utc),
    ])
    expect(at(measured, 30)[0]?.text).toBe("sabbath until 2026-10-22 18:09")
    expect(at(measured, 20)[0]?.text).toBe("sabbath")
    // No quota window read: the Sabbath row alone, and the band shows it.
    expect(at({ providers: [] }, 120)).toEqual([
      { text: "sabbath · no run starts until 2026-10-22 18:09", state: "none" },
    ])
    expect(
      texts({ lanes: Option.some({ providers: [], sabbathEnd: end }), runs: [] }, 120),
    ).toEqual(["≡ sabbath · no run starts until 2026-10-22 18:09"])
    // An end that passed names nothing, and the band hides again.
    expect(laneRows({ providers: [], sabbathEnd: NOW }, NOW, 120, utc)).toEqual([
      { text: "lanes unknown", state: "unknown" },
    ])
    expect(
      texts({ lanes: Option.some({ providers: [], sabbathEnd: NOW }), runs: [] }, 120),
    ).toEqual([])
  })

  test("a Sabbath that ends today names a clock only, so its full row fits narrower", () => {
    const end = Date.UTC(2026, 9, 21, 18, 9)
    const at = (width: number) => laneRows({ providers: [], sabbathEnd: end }, NOW, width, utc)[0]
    expect(at(120)).toEqual({ text: "sabbath · no run starts until 18:09", state: "none" })
    expect(at(40)?.text).toBe("sabbath · no run starts until 18:09")
    expect(at(30)?.text).toBe("sabbath until 18:09")
    expect(at(19)?.text).toBe("sabbath until 18:09")
    expect(at(18)?.text).toBe("sabbath")
  })

  test("every lane held by a running run says how many run, not a clock", () => {
    const busy: LaneReport = {
      providers: measured.providers.map((lanes) => ({ ...lanes, load: 5 })),
    }
    expect(laneRows(busy, NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 0/5 free · 5 running", state: "none" },
    ])
    // A refusal holds the account with no window spent: no clock to name, and no run.
    const held: LaneReport = {
      providers: [
        {
          provider: "anthropic",
          scope: [DEFAULT],
          fuelPerHour: 3_400_000,
          laneHours: 0,
          models: [],
          accounts: [
            {
              slot: DEFAULT,
              windows: [window("5h", { sustainable: 2 })],
              held: true,
              sustainable: 0,
            },
          ],
          capacity: 0,
          load: 0,
        },
      ],
    }
    expect(laneRows(held, NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 0/0 free · held", state: "none" },
    ])
  })

  test("runs of cheap models hold part of a lane: the free count reads their shares", () => {
    const shared = (load: number): LaneReport => ({
      providers: measured.providers.map((lanes) => ({ ...lanes, load })),
    })
    expect(laneRows(shared(2.5), NOW, 30, utc)).toEqual([
      { text: "lanes anthropic 2.5/5 free", state: "free" },
    ])
    // A sliver under a tenth still admits a cheap enough run: it reads free.
    expect(laneRows(shared(4.98), NOW, 30, utc)).toEqual([
      { text: "lanes anthropic <0.1/5 free", state: "free" },
    ])
    // Shares that fill the lanes to a float's error leave none free.
    expect(laneRows(shared(0.1 + 0.2 + 4.7), NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 0/5 free · 5 running", state: "none" },
    ])
  })

  test("a window with no rate, or no reading at all, is unknown", () => {
    expect(laneRows(unrated, NOW, 120, utc)).toEqual([
      { text: "lanes anthropic unknown", state: "unknown" },
    ])
    expect(laneRows(unrated, NOW, 20, utc)[0]?.text).toBe("lanes unknown")
    expect(laneRows({ providers: [] }, NOW, 120, utc)).toEqual([
      { text: "lanes unknown", state: "unknown" },
    ])
  })

  test("a lost login follows its provider's row and names where to sign in", () => {
    const lost = (
      report: LaneReport,
      reason: "Rejected" | "Unavailable" = "Rejected",
    ): LaneReport => ({
      providers: report.providers.map((lanes) => ({
        ...lanes,
        accounts: [
          ...lanes.accounts,
          { slot: WORK, windows: [], held: false, loginLost: { since: NOW - MINUTE, reason } },
        ],
      })),
    })
    expect(laneRows(lost(measured), NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%", state: "free" },
      { text: "login! anthropic work refused · sign in with /auth", state: "none" },
    ])
    // A sign-in gent holds no login for reads unavailable.
    expect(laneRows(lost(measured, "Unavailable"), NOW, 120, utc)[1]?.text).toBe(
      "login! anthropic work unavailable · sign in with /auth",
    )
    // A narrow row drops the remedy, then the reason, then the provider; `login!` stays.
    const at = (width: number) => laneRows(lost(measured), NOW, width, utc)[1]?.text
    expect(at(50)).toBe("login! anthropic work refused · sign in with /auth")
    expect(at(49)).toBe("login! anthropic work refused")
    expect(at(28)).toBe("login! anthropic work")
    expect(at(20)).toBe("login! work")
    for (const width of [50, 49, 29, 28, 21, 20, 11, 10, 7]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
      expect(at(width)).toContain("login!")
    }
    // The band draws it as a lanes row; a provider with only a lost login shows too.
    expect(texts({ lanes: Option.some(lost(measured)), runs: [] }, 120)).toEqual([
      "≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%",
      "≡ login! anthropic work refused · sign in with /auth",
    ])
    // No reading, no scope: the server lists the provider for its lost login alone.
    const alone = lost({
      providers: unrated.providers.map((lanes) => ({ ...lanes, scope: [], accounts: [], load: 0 })),
    })
    expect(texts({ lanes: Option.some(alone), runs: [] }, 120)).toEqual([
      "≡ lanes anthropic unknown",
      "≡ login! anthropic work refused · sign in with /auth",
    ])
  })

  test("banked resets follow their provider's rows: each account's live count and the soonest lapse", () => {
    expect(laneRows(banked, NOW, 120, utc)).toEqual([
      { text: "lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%", state: "free" },
      { text: "resets anthropic default 2, work 1 · next lapses 15:00", state: "banked" },
    ])
    // A narrow row drops the lapse, then the provider, then reads the total.
    const at = (width: number) => laneRows(banked, NOW, width, utc)[1]?.text
    expect(at(54)).toBe("resets anthropic default 2, work 1 · next lapses 15:00")
    expect(at(53)).toBe("resets anthropic default 2, work 1")
    expect(at(33)).toBe("resets default 2, work 1")
    expect(at(23)).toBe("resets 3")
    for (const width of [54, 53, 34, 33, 24, 23, 8, 7, 4]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
    }
    // Past 15:00 default's grant has lapsed too: work's alone counts, with no lapse to name.
    expect(laneRows(banked, NOW + 3 * HOUR, 120, utc)[1]).toEqual({
      text: "resets anthropic work 1",
      state: "banked",
    })
    // An account with none, or only lapsed grants, shows nothing; nor does
    // one out of the scope, whatever it holds.
    expect(laneRows(measured, NOW, 120, utc).map((row) => row.state)).toEqual(["free"])
    // The band draws the row with its own mark after the provider's lanes and lost logins.
    expect(texts({ lanes: Option.some(banked), runs: [] }, 120)).toEqual([
      "≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%",
      "↺ resets anthropic default 2, work 1 · next lapses 15:00",
    ])
  })

  test("each active run follows the lanes: machine, state, round and age; a waiting round names its clock", () => {
    const data: BandData = {
      lanes: Option.some(measured),
      runs: [
        run({}),
        run({
          run: "run-0000000000000002",
          machine: "review",
          state: "review",
          visits: { review: 1 },
          createdAt: NOW - 2 * HOUR,
          // oxlint-disable-next-line effect/preferTaggedConstructors -- the wire form the request's decoder reads
          pending: {
            _tag: "Round",
            state: "review",
            key: "machine:run-0000000000000002:3",
            visit: 1,
            attempt: 1,
            notBefore: NOW + 47 * MINUTE,
          },
        }),
        run({
          run: "run-0000000000000003",
          status: "asking",
          state: "decide",
          createdAt: NOW - 10_000,
        }),
        run({ run: "run-0000000000000004", status: "final" }),
      ],
    }
    expect(texts(data, 120)).toEqual([
      "≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%",
      "◷ review review r1 2h · wait 12:47",
      "▸ track implement r2 4m",
      "? track decide r0 10s",
    ])
    // Narrow: each row fits, the free count stays, a wait too long for the row drops its clock.
    expect(texts(data, 22)).toEqual([
      "≡ lanes 3/5 free",
      "◷ review review r1 2h",
      "▸ track implement r2 4m",
      "? track decide r0 10s",
    ])
  })

  test("the peer row comes last: its host, its runs and its last line's age; a narrow row drops the host, then the age", () => {
    expect(laneRows(withPeer(linked), NOW, 120, utc)).toEqual([
      ...laneRows(measured, NOW, 120, utc),
      { text: "peer workbox 2 runs · 12s", state: "linked" },
    ])
    expect(laneRows(withPeer({ ...linked, runs: 1 }), NOW, 120, utc)[1]?.text).toBe(
      "peer workbox 1 run · 12s",
    )
    const at = (width: number) => laneRows(withPeer(linked), NOW, width, utc)[1]?.text
    expect(at(25)).toBe("peer workbox 2 runs · 12s")
    expect(at(24)).toBe("peer 2 runs · 12s")
    expect(at(17)).toBe("peer 2 runs · 12s")
    expect(at(16)).toBe("peer 2 runs")
    expect(at(11)).toBe("peer 2 runs")
    for (const width of [25, 24, 19, 18, 17, 16, 11, 10, 4]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
    }
    // The band draws it with its own mark; a peer alone shows the band, after lanes unknown.
    expect(texts({ lanes: Option.some(withPeer(linked)), runs: [] }, 120)).toEqual([
      "≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%",
      "⇄ peer workbox 2 runs · 12s",
    ])
    expect(
      texts({ lanes: Option.some(withPeer(linked, { providers: [] })), runs: [] }, 120),
    ).toEqual(["≡ lanes unknown", "⇄ peer workbox 2 runs · 12s"])
  })

  test("a silent peer reads unread and its age; a link down marks peer! and names the link", () => {
    const row = (peer: NonNullable<LaneReport["peer"]>, width = 120) =>
      laneRows(withPeer(peer), NOW, width, utc)[1]
    // Past the hold: silent, and none of its runs count.
    const silent = {
      ...linked,
      heard: { host: "workbox", at: NOW - 3 * MINUTE },
      runs: 0,
      silent: true,
    }
    expect(row({ ...silent, down: ["peer"] })).toEqual({
      text: "peer! workbox unread 3m · peer link down",
      state: "unlinked",
    })
    // This server's link stopped: silent, with no link to blame.
    expect(row(silent)).toEqual({ text: "peer workbox unread 3m", state: "unlinked" })
    // Lines come over the peer's link alone: live, and marked.
    expect(row({ ...linked, down: ["own"] })).toEqual({
      text: "peer! workbox 2 runs · 12s · own link down",
      state: "unlinked",
    })
    expect(row({ ...silent, down: ["own", "peer"] })?.text).toBe(
      "peer! workbox unread 3m · links down",
    )
    // No line yet: unread, and marked once this server's link has run 90 s.
    expect(row({ runs: 0, silent: true, down: [] })).toEqual({
      text: "peer unread",
      state: "unlinked",
    })
    expect(row({ runs: 0, silent: true, down: ["own"] })?.text).toBe("peer! unread · own link down")
    expect(row({ runs: 0, silent: true, down: ["own"] }, 27)?.text).toBe("peer! unread")
    // A narrow row keeps the link down over the age, and the age over the host; `peer!` stays.
    const at = (width: number) => row({ ...silent, down: ["peer"] }, width)?.text
    expect(at(40)).toBe("peer! workbox unread 3m · peer link down")
    expect(at(39)).toBe("peer! unread 3m · peer link down")
    expect(at(32)).toBe("peer! unread 3m · peer link down")
    expect(at(31)).toBe("peer! unread · peer link down")
    expect(at(29)).toBe("peer! unread · peer link down")
    expect(at(28)).toBe("peer! workbox unread 3m")
    expect(at(22)).toBe("peer! unread 3m")
    expect(at(14)).toBe("peer! unread")
    // Live with a link down: the link outlives the age and the host too.
    const live = (width: number) => row({ ...linked, down: ["own"] }, width)?.text
    expect(live(41)).toBe("peer! 2 runs · 12s · own link down")
    expect(live(33)).toBe("peer! 2 runs · own link down")
    expect(live(27)).toBe("peer! workbox 2 runs · 12s")
    expect(live(17)).toBe("peer! 2 runs")
    for (const width of [40, 39, 33, 32, 31, 29, 28, 23, 22, 20, 15, 14, 12, 11, 5]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
      expect(textWidth(live(width) ?? "")).toBeLessThanOrEqual(width)
      expect(at(width)).toContain("peer")
    }
  })

  test("a silent peer's held runs show on its row: they outlive the link down, the age and the host", () => {
    const row = (peer: NonNullable<LaneReport["peer"]>, width = 120) =>
      laneRows(withPeer(peer), NOW, width, utc)[1]?.text
    // In the hold: silent, its two last runs still count against this pool.
    const held = {
      ...linked,
      heard: { host: "workbox", at: NOW - 3 * MINUTE },
      silent: true,
      down: ["peer" as const],
    }
    expect(row(held)).toBe("peer! workbox unread 3m · 2 runs held · peer link down")
    expect(row({ ...held, runs: 1, down: [] })).toBe("peer workbox unread 3m · 1 run held")
    const at = (width: number) => row(held, width)
    expect(at(54)).toBe("peer! workbox unread 3m · 2 runs held · peer link down")
    expect(at(53)).toBe("peer! unread 3m · 2 runs held · peer link down")
    expect(at(46)).toBe("peer! unread 3m · 2 runs held · peer link down")
    expect(at(45)).toBe("peer! unread · 2 runs held · peer link down")
    expect(at(42)).toBe("peer! workbox unread 3m · 2 runs held")
    expect(at(36)).toBe("peer! unread 3m · 2 runs held")
    expect(at(28)).toBe("peer! unread · 2 runs held")
    expect(at(25)).toBe("peer! workbox unread 3m")
    expect(at(22)).toBe("peer! unread 3m")
    expect(at(14)).toBe("peer! unread")
    for (const width of [54, 53, 46, 45, 43, 42, 37, 36, 29, 28, 26, 25, 23, 22, 15, 14, 12, 11]) {
      expect(textWidth(at(width) ?? "")).toBeLessThanOrEqual(width)
    }
  })

  test("the band hides with no reading and no active run; a run alone shows lanes unknown", () => {
    expect(bandRows({ lanes: Option.none(), runs: [] }, NOW, 120, utc)).toEqual([])
    expect(bandRows({ lanes: Option.some({ providers: [] }), runs: [] }, NOW, 120, utc)).toEqual([])
    expect(
      bandRows(
        { lanes: Option.some({ providers: [] }), runs: [run({ status: "final" })] },
        NOW,
        120,
        utc,
      ),
    ).toEqual([])
    expect(texts({ lanes: Option.none(), runs: [run({})] }, 120)).toEqual([
      "≡ lanes unknown",
      "▸ track implement r2 4m",
    ])
  })
})

// ── rendered band ───────────────────────────────────────────────────────────

describe("the lanes band", () => {
  for (const [width, rows] of [
    [120, ["≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%", "▸ track implement r2 4m"]],
    [40, ["≡ lanes anthropic 3/5 free · 5h 120k/%", "▸ track implement r2 4m"]],
  ] as const) {
    it.scopedLive(`draws the lanes row and each active run at ${width} columns`, () =>
      Effect.gen(function* () {
        const data: BandData = { lanes: Option.some(measured), runs: [run({})] }
        const setup = yield* renderScoped(() => <LanesBand data={() => data} now={() => NOW} />, {
          width,
          height: 6,
        })
        yield* waitForFrame(setup, () => renderFrame(setup).includes("≡"), "band")
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        expect(lines).toEqual([...rows])
      }),
    )
  }

  for (const [width, rows] of [
    [
      120,
      [
        "≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%",
        "↺ resets anthropic default 2, work 1 · next lapses 15:00",
      ],
    ],
    [40, ["≡ lanes anthropic 3/5 free · 5h 120k/%", "↺ resets anthropic default 2, work 1"]],
    [28, ["≡ lanes anthropic 3/5 free", "↺ resets default 2, work 1"]],
  ] as const) {
    it.scopedLive(`draws each account's banked resets under its lanes at ${width} columns`, () =>
      Effect.gen(function* () {
        const data: BandData = { lanes: Option.some(banked), runs: [] }
        const setup = yield* renderScoped(() => <LanesBand data={() => data} now={() => NOW} />, {
          width,
          height: 6,
        })
        yield* waitForFrame(setup, () => renderFrame(setup).includes("↺"), "resets row")
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        expect(lines).toEqual([...rows])
      }),
    )
  }

  for (const [width, rows] of [
    [120, ["≡ lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%", "⇄ peer workbox 2 runs · 12s"]],
    [26, ["≡ lanes 3/5 free", "⇄ peer 2 runs · 12s"]],
  ] as const) {
    it.scopedLive(`draws the peer row last at ${width} columns`, () =>
      Effect.gen(function* () {
        const data: BandData = { lanes: Option.some(withPeer(linked)), runs: [] }
        const setup = yield* renderScoped(() => <LanesBand data={() => data} now={() => NOW} />, {
          width,
          height: 6,
        })
        yield* waitForFrame(setup, () => renderFrame(setup).includes("⇄"), "peer row")
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        expect(lines).toEqual([...rows])
      }),
    )
  }

  it.scopedLive("hides when nothing is measured and no run is active", () =>
    Effect.gen(function* () {
      const [data, setData] = createSignal<BandData>({ lanes: Option.some(spent), runs: [] })
      const setup = yield* renderScoped(() => <LanesBand data={data} now={() => NOW} />, {
        width: 80,
        height: 6,
      })
      yield* waitForFrame(setup, () => renderFrame(setup).includes("0 free"), "spent band")
      setData({ lanes: Option.some({ providers: [] }), runs: [] })
      yield* waitForFrame(setup, () => renderFrame(setup).trim() === "", "band hidden")
    }),
  )
})

// ── reads ───────────────────────────────────────────────────────────────────

describe("the lanes band reads", () => {
  // A completed turn and a reconnect read the lanes and the runs again;
  // another event reads nothing.
  it.scopedLive("displays fresh lanes on load, TurnCompleted, reconnect and the 30 s poll", () =>
    Effect.gen(function* () {
      const session = { sessionId: SessionId.make("s"), branchId: BranchId.make("s-branch") }
      const reads = yield* Queue.unbounded<string>()
      const report = yield* Ref.make(measured)
      const clock = yield* TestClock.make()
      const [connection, setConnection] = createSignal(Option.some(1))
      const subscribers = new Set<(envelope: EventEnvelope) => void>()
      const options = {
        currentSession: () => session,
        sessionEventSubscribers: subscribers,
        connection,
        requestEffect: (request: { readonly capabilityId: string }) =>
          Queue.offer(reads, request.capabilityId).pipe(Effect.as([])),
      }
      const deliver = (event: AgentEvent) => {
        const envelope = EventEnvelope.make({ id: EventId.make(1), event, createdAt: 0 })
        for (const cb of subscribers) cb(envelope)
      }
      const base = makeClientTestTransport(options)
      const client = createMockClient({
        extension: base.client.extension,
        accounts: { lanes: () => Ref.get(report) },
      })
      const transport = { ...base, client, accountLanes: client.accounts.lanes() }
      const contributions = yield* provideClientServices(
        machinesExtension.setup.pipe(Effect.provideService(Clock.Clock, clock)),
        { ...options, transport },
      )
      const band = Option.getOrThrow(
        Option.fromUndefinedOr(
          contributions.widgets?.find((widget) => widget.id === "machines.band"),
        ),
      )
      const setup = yield* renderScoped(() => <band.component />, { width: 120, height: 6 })
      const shows = (text: string) =>
        waitForFrame(setup, () => renderFrame(setup).includes(text), text)
      expect(yield* Queue.take(reads)).toBe("run-list")
      yield* shows("≡ lanes anthropic 3/5 free")
      deliver(
        AgentEvent.cases.StreamSynchronized.make({ ...session, lastEventId: EventId.make(1) }),
      )
      yield* Ref.set(report, {
        ...measured,
        providers: measured.providers.map((provider) => ({ ...provider, load: 3 })),
      })
      deliver(
        AgentEvent.cases.TurnCompleted.make({ streamFailed: false, ...session, durationMs: 10 }),
      )
      expect(yield* Queue.take(reads)).toBe("run-list")
      yield* shows("≡ lanes anthropic 2/5 free")
      // One read for the turn; the other event read nothing.
      expect(yield* Queue.size(reads)).toBe(0)
      yield* Ref.set(report, {
        ...measured,
        providers: measured.providers.map((provider) => ({ ...provider, load: 4 })),
      })
      setConnection(Option.none())
      setConnection(Option.some(2))
      expect(yield* Queue.take(reads)).toBe("run-list")
      yield* shows("≡ lanes anthropic 1/5 free")
      expect(yield* Queue.size(reads)).toBe(0)
      yield* Ref.set(report, unrated)
      yield* clock.adjust("29 seconds")
      expect(yield* Queue.size(reads)).toBe(0)
      expect(renderFrame(setup)).toContain("≡ lanes anthropic 1/5 free")
      yield* clock.adjust("1 second")
      expect(yield* Queue.take(reads)).toBe("run-list")
      yield* shows("≡ lanes anthropic unknown")
    }).pipe(Effect.timeout("4 seconds")),
  )

  // A heard peer and a run's start are server times: the band reads them on
  // the server's clock, so a client whose clock is off reads the true ages.
  for (const [label, offset] of [
    ["120 s ahead of", -120_000],
    ["120 s behind", 120_000],
  ] as const) {
    it.scopedLive(
      `a client ${label} the server reads the peer's and a run's age on the server's clock`,
      () =>
        Effect.gen(function* () {
          const serverNow = DateTime.toEpochMillis(DateTime.nowUnsafe()) + offset
          const report = withPeer({
            ...linked,
            heard: { host: "workbox", at: serverNow - 5 * MINUTE },
          })
          const options = {
            serverClockOffset: () => Option.some(offset),
            requestEffect: () => Effect.succeed([run({ createdAt: serverNow - 9 * MINUTE })]),
          }
          const base = makeClientTestTransport(options)
          const client = createMockClient({
            extension: base.client.extension,
            accounts: { lanes: () => Effect.succeed(report) },
          })
          const transport = { ...base, client, accountLanes: client.accounts.lanes() }
          const contributions = yield* provideClientServices(machinesExtension.setup, {
            ...options,
            transport,
          })
          const band = Option.getOrThrow(
            Option.fromUndefinedOr(
              contributions.widgets?.find((widget) => widget.id === "machines.band"),
            ),
          )
          const setup = yield* renderScoped(() => <band.component />, { width: 120, height: 6 })
          yield* waitForFrame(
            setup,
            () => renderFrame(setup).includes("⇄") && renderFrame(setup).includes("▸"),
            "the run and peer rows",
          )
          const lines = renderFrame(setup).split("\n")
          expect(lines.find((line) => line.includes("▸"))?.trim()).toBe("▸ track implement r2 9m")
          expect(lines.find((line) => line.includes("⇄"))?.trim()).toBe(
            "⇄ peer workbox 2 runs · 5m",
          )
        }).pipe(Effect.timeout("4 seconds")),
    )
  }
})
