import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import {
  BunGentPlatformLive,
  makeTempDirectoryScoped,
  testSqliteStorage,
} from "@gent/core/test-utils"
import { GentPlatform } from "@gent/core/host"
import { runProcess } from "@gent/core/extensions/api"
import {
  Config,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { it } from "effect-bun-test"
import {
  decodeState,
  contextPerCall,
  gateFailures,
  extensionPulses,
  failureText,
  isSettled,
  QUIET_READS,
  type RunRecord,
  WAIT_START,
  waitStep,
  sendAwaitsTurn,
  latestEventId,
  newestInFamily,
  openTurnSessions,
  resolvePreset,
  encodeState,
  parseCount,
  parseUpArgs,
  proxyEnv,
  runRecord,
  rereadEstimate,
  sessionStatuses,
  userMessageTexts,
  presetConfigJson,
  PRESETS,
  rewriteRoster,
  rosterBlock,
  screenText,
  stateFileFor,
  testSummary,
  type GamutState,
} from "../gamut"

/** A models.dev slice: older releases, dated snapshots and variants beside the newest. */
const catalog = {
  anthropic: [
    "claude-opus-4-5-20251101",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5",
    // The newest release's snapshot before its undated entry: only the anchored pattern skips it.
    "claude-haiku-5-5-20261022",
    "claude-haiku-5-5",
  ],
  openai: ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-pro", "gpt-5.6-sol", "gpt-6-sol"],
}

const preset = resolvePreset(PRESETS["opus-luna"]!, catalog)

describe("gamut model families", () => {
  test("a family resolves to its newest release, not a snapshot or a variant", () => {
    expect(newestInFamily("anthropic/opus", catalog.anthropic)).toBe("anthropic/claude-opus-5-5")
    expect(newestInFamily("anthropic/sonnet", catalog.anthropic)).toBe("anthropic/claude-sonnet-5")
    expect(newestInFamily("anthropic/fable", catalog.anthropic)).toBe("anthropic/claude-fable-5-1")
    expect(newestInFamily("anthropic/haiku", catalog.anthropic)).toBe("anthropic/claude-haiku-5-5")
    expect(newestInFamily("openai/sol", catalog.openai)).toBe("openai/gpt-6-sol")
    expect(newestInFamily("openai/luna", catalog.openai)).toBe("openai/gpt-6-luna")
  })

  test("a release number compares as numbers: 5.10 is newer than 5.9", () => {
    expect(newestInFamily("openai/sol", ["gpt-5.9-sol", "gpt-5.10-sol"])).toBe(
      "openai/gpt-5.10-sol",
    )
  })

  test("a dated snapshot of a two-part release is no minor version", () => {
    expect(
      newestInFamily("anthropic/sonnet", ["claude-sonnet-4-5", "claude-sonnet-4-20250514"]),
    ).toBe("anthropic/claude-sonnet-4-5")
    expect(
      newestInFamily("anthropic/opus", [
        "claude-opus-6",
        "claude-opus-6-1",
        "claude-opus-6-20270101",
      ]),
    ).toBe("anthropic/claude-opus-6-1")
  })

  test("every preset resolves each role to a catalog model and an effort", () => {
    for (const [name, named] of Object.entries(PRESETS)) {
      const resolved = resolvePreset(named, catalog)
      for (const role of [resolved.orchestrator, resolved.worker, resolved.reviewer]) {
        expect(role.modelId, name).toMatch(/^(anthropic\/claude|openai\/gpt)-/)
        expect(role.reasoningEffort, name).not.toBe("")
      }
    }
  })

  test("a family with no release in the catalog stops the run", () => {
    expect(() => resolvePreset(PRESETS["sol-luna"]!, { anthropic: catalog.anthropic })).toThrow(
      "no openai/sol release",
    )
  })
})

describe("gamut preset config", () => {
  test("the sol preset assigns ordinary work and review to Sol at high effort", () => {
    const ordinary = resolvePreset(PRESETS["sol"]!, catalog)
    const role = Schema.Struct({ model: Schema.String, reasoningEffort: Schema.String })
    const config = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({ agents: Schema.Struct({ main: role, delegate: role }) }),
      ),
    )(presetConfigJson(ordinary))
    expect(config.agents.main).toEqual({ model: "openai/gpt-6.1-sol", reasoningEffort: "high" })
    expect(config.agents.delegate).toEqual(config.agents.main)
    expect(ordinary.reviewer).toEqual({ modelId: "openai/gpt-6.1-sol", reasoningEffort: "high" })
  })
  // The exact bytes matter: this is the file gent reads from the work dir.
  test("pins the orchestrator as agent main, the worker as agent delegate, and the machine tiers to the preset", () => {
    expect(presetConfigJson(preset)).toBe(
      `{
  "agents": {
    "main": {
      "model": "anthropic/claude-opus-5-5",
      "reasoningEffort": "low"
    },
    "delegate": {
      "model": "openai/gpt-6-luna",
      "reasoningEffort": "max"
    }
  },
  "tiers": {
    "strongest": [
      "anthropic/claude-opus-5-5"
    ],
    "efficient": [
      "openai/gpt-6-luna"
    ]
  }
}
`,
    )
  })
})

describe("gamut roster block", () => {
  test("names the paired worker and the thread.start model and effort the orchestrator must pass", () => {
    const block = rosterBlock(preset)
    expect(block).toContain("paired in `.gent/config.json` as `openai/gpt-6-luna` at `max`")
    expect(block).toContain("Repetitive mechanical changes following an established pattern only")
    expect(block).toContain("`model` = `openai/gpt-6-luna`")
    expect(block).toContain("`model` = `anthropic/claude-opus-5-5`")
    expect(block).not.toContain("modelId")
    expect(block).not.toContain("overrides")
    expect(block).toContain("`effort` = `high`")
  })

  test("a rewrite replaces only the block and keeps the prose around it", () => {
    const before =
      "# rules\n\nprose above\n\n<!-- roster -->\n- stale\n<!-- /roster -->\n\nprose below\n"
    const after = rewriteRoster(before, preset)
    expect(after).toContain("prose above")
    expect(after).toContain("prose below")
    expect(after).not.toContain("- stale")
    expect(after).toContain("openai/gpt-6-luna")
  })

  test("a second rewrite is stable", () => {
    const once = rewriteRoster("a\n<!-- roster -->\nx\n<!-- /roster -->\nb\n", preset)
    expect(rewriteRoster(once, preset)).toBe(once)
  })

  test("a body with no roster block is refused", () => {
    expect(() => rewriteRoster("# rules\n\nno markers here\n", preset)).toThrow("no roster block")
  })
})

describe("gamut state file", () => {
  test("two checkouts get two state files", () => {
    const a = stateFileFor("/Users/x/.rifts/gent/fold-tui")
    const b = stateFileFor("/Users/x/.rifts/gent/fold-extensions")
    expect(a).not.toBe(b)
    expect(a.endsWith("gent-gamut-fold-tui.json")).toBe(true)
  })

  const state: GamutState = {
    root: "/tmp/gent-gamut-1",
    work: "/tmp/gent-gamut-1/work",
    data: "/tmp/gent-gamut-1/data",
    socket: "/tmp/gent-gamut-1/host.sock",
    hostPid: 4242,
    binary: "/checkout/apps/tui/bin/gent",
    preset: "sol-luna",
    sendMark: 7,
    awaitsTurn: false,
  }

  test("round trips every field", () => {
    expect(decodeState(encodeState(state))).toEqual(state)
  })

  test("a missing field is refused rather than read as undefined", () => {
    expect(() => decodeState(`{"root":"/tmp/x"}`)).toThrow('Missing key\n  at ["work"]')
  })

  test("the state file holds the schema's fields in its order, two-space indented", () => {
    const { root, ...rest } = state
    const reordered = { ...rest, root, stray: "x" }
    const written = encodeState(reordered)
    expect(written).toBe(encodeState(state))
    expect(written.split("\n").slice(0, 2)).toEqual(["{", '  "root": "/tmp/gent-gamut-1",'])
    expect(written.endsWith("}\n")).toBe(true)
  })
})

describe("gamut proxy environment", () => {
  // The TUI takes no environment from the caller, so a run started under
  // `teamclaude env --mitm` reached Anthropic on the owner's own account.
  const variablesUnder = (env: Record<string, string>) =>
    proxyEnv.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    )

  it.effect("each of the eight proxy variables reaches the TUI by name, and no other does", () =>
    Effect.gen(function* () {
      const variables = yield* variablesUnder({
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        http_proxy: "http://h:2",
        HTTP_PROXY: "http://H:2",
        https_proxy: "http://h:1",
        HTTPS_PROXY: "http://H:1",
        NO_PROXY: "LOCALHOST",
        ANTHROPIC_BASE_URL: "http://localhost:3456",
        PATH: "/bin",
      })
      expect(variables).toEqual({
        HTTPS_PROXY: "http://H:1",
        https_proxy: "http://h:1",
        HTTP_PROXY: "http://H:2",
        http_proxy: "http://h:2",
        NO_PROXY: "LOCALHOST",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        ANTHROPIC_BASE_URL: "http://localhost:3456",
      })
    }),
  )

  it.effect("an unset or empty proxy variable is left out", () =>
    Effect.gen(function* () {
      expect(yield* variablesUnder({ HTTPS_PROXY: "http://H:1", HTTP_PROXY: "" })).toEqual({
        HTTPS_PROXY: "http://H:1",
      })
      expect(yield* variablesUnder({ PATH: "/bin" })).toEqual({})
    }),
  )
})

describe("gamut read output", () => {
  test("a read with no new rows says so, and a full read prints the screen as it is", () => {
    expect(screenText({ rows: [], gone: 0 }, false)).toBe("(no change)")
    expect(screenText({ rows: ["> "], gone: 0 }, true)).toBe("> ")
  })

  test("the rows gone since the last read, then the exit code, follow the rows", () => {
    expect(screenText({ rows: ["bye"], gone: 2, exited: 3 }, false)).toBe(
      "bye\n(2 rows of the last read are gone)\n(gent exited 3)",
    )
  })
})

describe("a settled run", () => {
  const finished = { started: true, open: [], stored: true }
  const idlePane = "idle · work (main)\n"

  /** Fold a script of pane reads; the index of the read that settles the wait, or -1. */
  const settlesAt = (
    reads: ReadonlyArray<readonly [string, RunRecord]>,
    awaitsTurn: boolean,
  ): number => {
    let progress = WAIT_START
    return reads.findIndex(([paneText, record]) => {
      progress = waitStep(progress, paneText, record, awaitsTurn)
      return isSettled(progress)
    })
  }
  const repeated = (paneText: string, record: RunRecord, count: number) =>
    Array.from({ length: count }, () => [paneText, record] as const)

  test("an idle status line with every turn ended settles on the second read", () => {
    const pane = "  Done.\n\nidle · work (main) · GPT-5.6 Sol · medium   ctx 1%\n"
    expect(settlesAt(repeated(pane, finished, 3), true)).toBe(1)
  })
  // The footer's first slot holds a held error or an extension notice in
  // place of the phase word (apps/tui/src/app.tsx, phaseLabels).
  test("a held error in the footer still settles once every turn has ended", () => {
    const pane = "  Done.\n\nprovider rejected the key · work (main) · GPT-5.6 Sol\n"
    expect(settlesAt(repeated(pane, finished, 2), true)).toBe(1)
  })
  test("an extension notice in the footer still settles once every turn has ended", () => {
    const pane = "wake alarm set for 10:00 · work (main) · GPT-5.6 Sol\n"
    expect(settlesAt(repeated(pane, finished, 2), true)).toBe(1)
  })
  // The turn line ends each finished turn as the last transcript row, so it
  // is inside the pane tail every wait reads.
  test("a finished turn's turn line settles on the second read", () => {
    const pane =
      "┃ fix the ledger\n\n  Done.\n\n  ✻ Worked for 42s · ↑12k ↓1.1k · $0.08\n\nidle · work (main) · GPT-6.1 Sol\n"
    expect(settlesAt(repeated(pane, finished, 3), true)).toBe(1)
  })
  test("an idle root with a working background child is not settled", () => {
    // The tray's running row: the pulse (`◇◈◆◈`) at its head, no state word.
    for (const pulse of ["◇", "◈"]) {
      const pane = `idle · work (main) · GPT-5.6 Sol\n ${pulse} delegate: Task 2. Read-only audit · Reading src  ← sessions\n`
      expect(settlesAt(repeated(pane, finished, 10), true)).toBe(-1)
    }
  })
  test("an idle root whose tray shows only a done thread settles", () => {
    const pane = "  Done.\n\nidle · work (main) · GPT-5.6 Sol\n ◆ release notes  ← sessions\n"
    expect(settlesAt(repeated(pane, finished, 3), true)).toBe(1)
  })
  test("a generating turn is not settled, whatever words the transcript echoes", () => {
    const generating = { started: true, open: ["main"], stored: true }
    const pane =
      "┃ Reply with the word idle · ready\n  ✻ Generating (3s)\nidle · work (main) · GPT-5.6 Sol\n"
    expect(settlesAt(repeated(pane, generating, 10), true)).toBe(-1)
  })
  test("an open turn in the record is not settled, whatever the pane shows", () => {
    const open = { started: true, open: ["child"], stored: true }
    expect(settlesAt(repeated(idlePane, open, 10), true)).toBe(-1)
  })
  test("a prompt whose turn never started is not settled, however long the pane is idle", () => {
    const quiet = { started: false, open: [], stored: false }
    expect(settlesAt(repeated("ready · work (main)\n", quiet, 20), true)).toBe(-1)
  })
  // `/plan` and `/review` queue a turn; the queued prompt can reach the event
  // log after the pane has already read idle twice.
  test("a slash command whose queued prompt lands after two idle reads waits for that turn", () => {
    const nothingYet = { started: false, open: [], stored: false }
    const queued = { started: true, open: ["main"], stored: true }
    const reads = [
      ...repeated(idlePane, nothingYet, 2),
      ...repeated("  ✻ Thinking (1s)\n", queued, 2),
      ...repeated(idlePane, finished, 2),
    ]
    expect(settlesAt(reads, false)).toBe(5)
  })
  // `/goal status` stores a hidden note: proof the command was handled.
  test("a slash command that stored a trace and started no turn settles on the second idle read", () => {
    const noted = { started: false, open: [], stored: true }
    expect(settlesAt(repeated(idlePane, noted, 3), false)).toBe(1)
  })
  // `/model …` changes a setting and may store nothing the record reads.
  test("a slash command that leaves no trace settles after the quiet period", () => {
    const quiet = { started: false, open: [], stored: false }
    expect(settlesAt(repeated(idlePane, quiet, QUIET_READS + 2), false)).toBe(QUIET_READS - 1)
  })
  test("a busy read restarts the quiet period", () => {
    const quiet = { started: false, open: [], stored: false }
    const reads = [
      ...repeated(idlePane, quiet, QUIET_READS - 1),
      [`${idlePane} ◇ delegate: audit  ← sessions\n`, quiet] as const,
      ...repeated(idlePane, quiet, QUIET_READS),
    ]
    expect(settlesAt(reads, false)).toBe(2 * QUIET_READS - 1)
  })
  test("a slash command is told from a prompt by its leading slash", () => {
    expect(sendAwaitsTurn("/model openai/gpt-5.6")).toBe(false)
    expect(sendAwaitsTurn("  /goal status")).toBe(false)
    expect(sendAwaitsTurn("also run typecheck")).toBe(true)
    expect(sendAwaitsTurn("use the path a/b")).toBe(true)
  })
})

describe("gamut command-line counts", () => {
  test("a positive whole number is read", () => {
    expect(parseCount("wait seconds", "600")).toBe(600)
  })
  test("a word, a fraction, zero or a negative is refused", () => {
    for (const value of ["abc", "1.5", "0", "-3", ""]) {
      expect(() => parseCount("wait seconds", value)).toThrow("must be a positive whole number")
    }
  })
})

describe("gamut failure line", () => {
  test("a command gives its last stderr line, then its last stdout line", () => {
    expect(failureText("building\n", "warning\nerror: no such file\n\n")).toBe(
      "error: no such file",
    )
    expect(failureText("only stdout\n", "")).toBe("only stdout")
    expect(failureText("", "")).toBe("no output")
  })
})

describe("gamut open turns", () => {
  // A bare `MessageReceived` is a user message: the prompt, a wake, a child's completion.
  const eventJson = (tag: string, role: string): string =>
    // oxlint-disable-next-line effect/noTernary, effect/noGlobals -- a raw SQLite row for the driver's queries, as the stored JSON spells it
    tag === "MessageReceived" ? JSON.stringify({ _tag: tag, message: { role } }) : "{}"
  const insert = (db: Database, session: string, tag: string, role = "user") =>
    db.run("INSERT INTO events (session_id, event_tag, event_json) VALUES (?, ?, ?)", [
      session,
      tag,
      eventJson(tag, role),
    ])
  const withEvents = (rows: ReadonlyArray<readonly [string, string, string?]>) => {
    const db = new Database(":memory:")
    db.run(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, event_tag TEXT, event_json TEXT)",
    )
    for (const [session, tag, role] of rows) insert(db, session, tag, role)
    return db
  }
  test("a child that received its task and has not finished is open", () => {
    const db = withEvents([
      ["parent", "MessageReceived"],
      ["parent", "StreamStarted"],
      ["parent", "TurnCompleted"],
      ["child", "MessageReceived"],
      ["child", "StreamStarted"],
    ])
    expect(openTurnSessions(db)).toEqual(["child"])
  })
  test("turns that completed or failed are closed", () => {
    const db = withEvents([
      ["done", "MessageReceived"],
      ["done", "StreamStarted"],
      ["done", "MessageReceived"],
      ["done", "TurnCompleted"],
      ["failed", "MessageReceived"],
      ["failed", "ErrorOccurred"],
      ["failed", "TurnCompleted"],
    ])
    expect(openTurnSessions(db)).toEqual([])
  })
  test("a notice error mid-turn leaves the turn open: only TurnCompleted ends it", () => {
    // Core publishes ErrorOccurred as a notice while a turn recovers (a
    // context overflow, a compaction fallback); the turn goes on.
    const db = withEvents([
      ["child", "MessageReceived"],
      ["child", "StreamStarted"],
      ["child", "ErrorOccurred"],
    ])
    expect(openTurnSessions(db)).toEqual(["child"])
  })
  test("the record says whether any turn has started", () => {
    expect(runRecord(withEvents([]), 0)).toEqual({ started: false, open: [], stored: false })
    expect(runRecord(withEvents([["s", "MessageReceived"]]), 0)).toEqual({
      started: true,
      open: ["s"],
      stored: true,
    })
  })
  // `send` marks the newest event id before it types; the message it sends
  // is stored after that mark, so a turn the previous prompt finished does
  // not count as the new one having run.
  test("a turn at or before the send mark does not count as started", () => {
    const db = withEvents([
      ["s", "MessageReceived"],
      ["s", "TurnCompleted"],
    ])
    expect(runRecord(db, 2)).toEqual({ started: false, open: [], stored: false })
    insert(db, "s", "MessageReceived")
    expect(runRecord(db, 2)).toEqual({ started: true, open: ["s"], stored: true })
  })
  test("the send mark is the newest event id, zero before any event", () => {
    expect(latestEventId(withEvents([]))).toBe(0)
    expect(
      latestEventId(
        withEvents([
          ["s", "MessageReceived"],
          ["s", "TurnCompleted"],
        ]),
      ),
    ).toBe(2)
  })
  // `/goal status` presents a note outside a turn: a hidden assistant message.
  test("an assistant message stored after the last turn neither opens nor starts one", () => {
    const db = withEvents([
      ["parent", "MessageReceived"],
      ["parent", "StreamStarted"],
      ["parent", "MessageReceived", "assistant"],
      ["parent", "TurnCompleted"],
      ["parent", "MessageReceived", "assistant"],
    ])
    // The note is stored after the mark: proof the command was handled.
    expect(runRecord(db, 4)).toEqual({ started: false, open: [], stored: true })
  })
  test("a stream that started after the send mark counts as a started turn", () => {
    const db = withEvents([
      ["s", "TurnCompleted"],
      ["s", "StreamStarted"],
    ])
    expect(runRecord(db, 1)).toEqual({ started: true, open: ["s"], stored: true })
  })
  test("a wake message after the last turn reopens the session", () => {
    const db = withEvents([
      ["parent", "MessageReceived"],
      ["parent", "TurnCompleted"],
      ["parent", "MessageReceived"],
    ])
    expect(openTurnSessions(db)).toEqual(["parent"])
  })
})

describe("gamut up arguments", () => {
  test("reads the preset, the prompt after --prompt, and --no-build in any order", () => {
    expect(parseUpArgs(["opus-luna"])).toEqual({
      preset: "opus-luna",
      // oxlint-disable-next-line effect/noNullish -- the driver reads an absent prompt as undefined
      prompt: undefined,
      // oxlint-disable-next-line effect/noNullish -- no --remote keeps the run local
      remote: undefined,
      build: true,
    })
    expect(parseUpArgs(["--prompt", "fix it", "opus-luna", "--no-build"])).toEqual({
      preset: "opus-luna",
      prompt: "fix it",
      // oxlint-disable-next-line effect/noNullish -- no --remote keeps the run local
      remote: undefined,
      build: false,
    })
  })
  test("a prompt that names the preset is still the prompt", () => {
    expect(parseUpArgs(["mixed", "--prompt", "mixed"])).toEqual({
      preset: "mixed",
      prompt: "mixed",
      // oxlint-disable-next-line effect/noNullish -- no --remote keeps the run local
      remote: undefined,
      build: true,
    })
  })
  test("--prompt with no value is refused, not replaced by the default prompt", () => {
    expect(() => parseUpArgs(["mixed", "--prompt"])).toThrow("--prompt needs a value")
    expect(() => parseUpArgs(["mixed", "--prompt", "--no-build"])).toThrow("--prompt needs a value")
  })
  test("--remote takes the repository URL, which is not the preset", () => {
    expect(parseUpArgs(["--remote", "https://github.com/o/r", "haiku", "--prompt", "go"])).toEqual({
      preset: "haiku",
      prompt: "go",
      remote: "https://github.com/o/r",
      build: true,
    })
    expect(() => parseUpArgs(["haiku", "--remote"])).toThrow("--remote needs a value")
    expect(() => parseUpArgs(["haiku", "--remote", "--no-build"])).toThrow("--remote needs a value")
  })
  test("a value flag given twice is refused, so the push target never depends on the order", () => {
    expect(() =>
      parseUpArgs([
        "haiku",
        "--remote",
        "https://github.com/o/a",
        "--remote",
        "https://github.com/o/b",
      ]),
    ).toThrow("--remote is given more than once")
    expect(() => parseUpArgs(["haiku", "--prompt", "a", "--prompt", "b"])).toThrow(
      "--prompt is given more than once",
    )
  })
})

describe("gamut status", () => {
  test("reads the bun test summary through its colour", () => {
    const coloured = "\u001b[0m\u001b[32m 17 pass\u001b[0m\n\u001b[0m\u001b[2m 0 fail\u001b[0m\n"
    expect(testSummary(coloured)).toBe("17 pass, 0 fail")
    expect(testSummary("no summary")).toBe("? pass, ? fail")
  })

  test("counts stored extension pulses per extension, most first", () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE events (id INTEGER PRIMARY KEY, event_tag TEXT, event_json TEXT)")
    const pulse = (extensionId: string) =>
      db.run("INSERT INTO events (event_tag, event_json) VALUES (?, ?)", [
        "ExtensionStateChanged",
        // oxlint-disable-next-line effect/noGlobals, effect/preferTaggedConstructors -- a raw SQLite row for the driver's queries, as the stored JSON spells it
        JSON.stringify({ _tag: "ExtensionStateChanged", extensionId }),
      ])
    expect(extensionPulses(db)).toEqual([])
    for (const id of ["@gent/session-tools", "@gent/btw", "@gent/btw", "@gent/btw"]) pulse(id)
    db.run("INSERT INTO events (event_tag, event_json) VALUES ('StreamStarted', '{}')")
    expect(extensionPulses(db)).toEqual([
      { extension: "@gent/btw", count: 3 },
      { extension: "@gent/session-tools", count: 1 },
    ])
  })

  /** The stored event fields the measures read. */
  interface StoredFields {
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
    readonly toolCallId?: string
    readonly toolName?: string
    readonly input?: { readonly path?: string }
    readonly output?: string
  }

  /** A run's database with the columns the measures read: two sessions, the second a child. */
  const runDb = () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)")
    db.run(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, event_tag TEXT, event_json TEXT)",
    )
    db.run("INSERT INTO sessions VALUES ('root', NULL), ('child', 'root')")
    const event = (session: string, tag: string, body: StoredFields = {}) =>
      db.run("INSERT INTO events (session_id, event_tag, event_json) VALUES (?, ?, ?)", [
        session,
        tag,
        // oxlint-disable-next-line effect/noGlobals -- a raw SQLite row for the driver's queries, as the stored JSON spells it
        JSON.stringify({ _tag: tag, ...body }),
      ])
    return { db, event }
  }

  test("measures the prompt of each model call, the roots and the children apart", () => {
    const { db, event } = runDb()
    expect(contextPerCall(db)).toEqual([])
    const ended = (session: string, inputTokens: number) =>
      event(session, "StreamEnded", { usage: { inputTokens, outputTokens: 1 } })
    ended("root", 10_000)
    ended("root", 20_000)
    ended("child", 30_000)
    // A step that reported no usage is not a measured call.
    event("child", "StreamEnded")
    expect(contextPerCall(db)).toEqual([
      { role: "root", calls: 2, mean: 15_000, max: 20_000 },
      { role: "child", calls: 1, mean: 30_000, max: 30_000 },
    ])
  })

  test("estimates the re-read part of the cells' output, at most each cell's own", () => {
    const { db, event } = runDb()
    // A database before the cell extension's first build has no cell table.
    expect(rereadEstimate(db)).toEqual({ cellChars: 0, reread: 0 })
    db.run(
      "CREATE TABLE cell_tool_operations (cell_tool_call_id TEXT, operation_id TEXT, record_json TEXT)",
    )
    let operations = 0
    /**
     * A cell in `session` answering `chars` that ran `reads`, each a path,
     * its output size and how it ended; `ended` is how the cell ended.
     */
    const cell = (
      session: string,
      id: string,
      chars: number,
      reads: ReadonlyArray<readonly [string, number, string?]>,
      ended = "ToolCallSucceeded",
    ) => {
      event(session, "ToolCallStarted", { toolCallId: id, toolName: "cell", input: {} })
      for (const [path, size, readEnded = "ToolCallSucceeded"] of reads) {
        const inner = `cell:${operations++}`
        db.run("INSERT INTO cell_tool_operations VALUES (?, ?, ?)", [
          id,
          inner,
          // oxlint-disable-next-line effect/noGlobals -- a raw SQLite row, as the stored JSON spells it
          JSON.stringify({ toolCallId: inner }),
        ])
        event(session, "ToolCallStarted", { toolCallId: inner, toolName: "read", input: { path } })
        event(session, readEnded, { toolCallId: inner, output: "r".repeat(size) })
      }
      event(session, ended, { toolCallId: id, output: "c".repeat(chars) })
    }
    cell("root", "c1", 100, [["a.ts", 50]])
    // a.ts again: its 60 chars, cut to the 40 the cell answered.
    cell("root", "c2", 40, [
      ["a.ts", 60],
      ["b.ts", 10],
    ])
    // Another session reads a.ts for the first time.
    cell("child", "c3", 30, [["a.ts", 70]])
    // b.ts again: its 20 chars, under the cell's 200.
    cell("root", "c4", 200, [["b.ts", 20]])
    expect(rereadEstimate(db)).toEqual({ cellChars: 370, reread: 60 })
    // A cell that failed still answered the model: its 80 chars, and a.ts again.
    cell("child", "c5", 80, [["a.ts", 25]], "ToolCallFailed")
    // A read that failed read nothing, so the next read of z.ts is the first.
    cell("child", "c6", 50, [["z.ts", 5, "ToolCallFailed"]])
    cell("child", "c7", 50, [["z.ts", 30]])
    expect(rereadEstimate(db)).toEqual({ cellChars: 550, reread: 85 })
  })

  test("counts the orchestrate machine's gate failures against its units", () => {
    const db = new Database(":memory:")
    // A database before the machines extension's first build has no machine tables.
    expect(gateFailures(db)).toEqual({ units: 0, gateFails: 0, mergeReds: 0 })
    db.run("CREATE TABLE machine_runs (run TEXT PRIMARY KEY, machine TEXT)")
    db.run("CREATE TABLE machine_steps (run TEXT, seq INTEGER, step_json TEXT)")
    db.run(
      "INSERT INTO machine_runs VALUES ('u1', 'orchestrate'), ('u2', 'orchestrate'), ('o1', 'other')",
    )
    let seq = 0
    const step = (run: string, tag: string, body: { readonly [field: string]: string }) =>
      db.run("INSERT INTO machine_steps VALUES (?, ?, ?)", [
        run,
        seq++,
        // oxlint-disable-next-line effect/noGlobals -- a raw SQLite row, as the stored JSON spells it
        JSON.stringify({ _tag: tag, ...body }),
      ])
    const moved = (run: string, from: string, to: string, by: string) =>
      step(run, "Moved", { from, to, by })
    // u1 fails its gate once and its merge once, then merges.
    moved("u1", "gate", "resume", "fail")
    moved("u1", "gate", "merge", "pass")
    moved("u1", "merge", "resume", "red")
    moved("u1", "gate", "merge", "pass")
    moved("u1", "merge", "merged", "green")
    moved("u2", "gate", "merge", "pass")
    // Another machine's gate, and a step that is not a move, do not count.
    moved("o1", "gate", "resume", "fail")
    step("u2", "Saved", { from: "gate", by: "fail" })
    expect(gateFailures(db)).toEqual({ units: 2, gateFails: 1, mergeReds: 1 })
  })
})

describe("gamut reads the schema gent builds", () => {
  // SQLite prepares each query as it runs, so a table or a column the
  // current schema lacks fails the read here, not in the next live run.
  it.live("every status and wait query runs on a fresh database", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-gamut-schema-")
      const file = `${dir}/data.db`
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`VACUUM INTO '${file}'`)
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(file, { readonly: true })),
        (opened) => Effect.sync(() => opened.close()),
      )
      expect(sessionStatuses(db)).toEqual([])
      expect(userMessageTexts(db)).toEqual([])
      expect(extensionPulses(db)).toEqual([])
      expect(contextPerCall(db)).toEqual([])
      expect(rereadEstimate(db)).toEqual({ cellChars: 0, reread: 0 })
      expect(gateFailures(db)).toEqual({ units: 0, gateFails: 0, mergeReds: 0 })
      expect(openTurnSessions(db)).toEqual([])
      expect(runRecord(db, 0)).toEqual({ started: false, open: [], stored: false })
      expect(latestEventId(db)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(testSqliteStorage), Effect.timeout("10 seconds")),
  )
})

/** The ids of the terminal hosts whose arguments name a path under `dir`. */
const hostsUnder = (dir: string) =>
  runProcess("ps", ["-axo", "pid=,args="]).pipe(
    Effect.map((ps) =>
      ps.stdout
        .split("\n")
        .filter((line) => line.includes("pty-host") && line.includes(dir))
        .map((line) => Number(line.trim().split(" ")[0])),
    ),
    Effect.orDie,
  )

/** Kill each terminal host under `dir`, so a failed test leaves no host behind. */
const reapHostsUnder = (dir: string) =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    for (const pid of yield* hostsUnder(dir)) {
      yield* platform.signal(pid, "SIGKILL").pipe(Effect.ignore)
    }
  })

/**
 * A process that looks like the terminal host of the run at `root` to
 * `ps`, and does nothing; the scope kills it.
 */
const hostLookalike = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const entry = yield* path.fromFileUrl(new URL(import.meta.resolve("@gent/e2e/pty-host")))
    // `; :` keeps the shell, and with it these arguments, from exec'ing sleep.
    const handle = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", "sleep 30; :", entry, path.join(root, "host.json")], {
        forceKillAfter: "5 seconds",
      }),
    )
    return Number(handle.pid)
  })

/** Whether process `pid` is alive. */
const running = (pid: number) =>
  runProcess("ps", ["-p", String(pid), "-o", "pid="]).pipe(
    Effect.map((ps) => ps.exitCode === 0),
    Effect.orDie,
  )

/** Repeat `probe` until `done` holds, failing loudly when it never does. */
const pollUntil = <A, E, R>(
  probe: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  what: string,
) =>
  probe.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () => Effect.die(new Error(`${what} never happened`)),
    }),
  )

describe("gamut CLI with a stopped host", () => {
  for (const scenario of [
    { name: "a stopped host allows cleanup", command: "down", exit: 0, kept: false },
    { name: "a stopped host cannot restart", command: "restart", exit: 1, kept: true },
  ]) {
    it.scopedLive(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const platform = yield* GentPlatform
          const scratch = yield* makeTempDirectoryScoped("gent-gamut-cli-")
          const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
          const root = path.join(scratch, "run")
          const statePath = path.join(
            scratch,
            `gent-gamut-${path.basename(path.resolve(path.dirname(driver), "../.."))}.json`,
          )
          yield* fs.makeDirectory(root)
          yield* fs.writeFileString(
            statePath,
            encodeState({
              root,
              work: root,
              data: root,
              // No host listens here, and process 1 is never a terminal host.
              socket: path.join(root, "host.sock"),
              hostPid: 1,
              binary: path.join(path.resolve(path.dirname(driver), "../.."), "apps/tui/bin/gent"),
              preset: "offline",
              sendMark: 0,
              awaitsTurn: false,
            }),
          )
          const result = yield* runProcess(yield* platform.execPath, [driver, scenario.command], {
            env: { TMPDIR: scratch },
            extendEnv: true,
          }).pipe(Effect.timeout("20 seconds"))
          expect(result.exitCode).toBe(scenario.exit)
          expect(yield* fs.exists(root)).toBe(scenario.kept)
          expect(yield* fs.exists(statePath)).toBe(scenario.kept)
          if (scenario.kept) {
            expect(result.stderr).toContain("the run's terminal host has stopped")
            expect(result.stderr).toContain(path.join(root, "host.log"))
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
          Effect.timeout("25 seconds"),
        ),
      30_000,
    )
  }
})

describe("gamut CLI with another run's host", () => {
  /** A state file for a run at `<scratch>/run` whose host is `hostPid`. */
  const runWith = (scratch: string, driver: string, hostPid: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.join(scratch, "run")
      const statePath = path.join(
        scratch,
        `gent-gamut-${path.basename(path.resolve(path.dirname(driver), "../.."))}.json`,
      )
      yield* fs.makeDirectory(root)
      yield* fs.writeFileString(
        statePath,
        encodeState({
          root,
          work: root,
          data: root,
          socket: path.join(root, "host.sock"),
          hostPid,
          binary: path.join(path.resolve(path.dirname(driver), "../.."), "apps/tui/bin/gent"),
          preset: "offline",
          sendMark: 0,
          awaitsTurn: false,
        }),
      )
      return { root, statePath }
    })

  it.scopedLive(
    "down leaves a host that serves another run running",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const scratch = yield* makeTempDirectoryScoped("gent-gamut-other-")
        const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
        // The recorded id now belongs to the host of a run elsewhere.
        const other = yield* hostLookalike(path.join(scratch, "elsewhere"))
        const { root, statePath } = yield* runWith(scratch, driver, other)
        const result = yield* runProcess(yield* platform.execPath, [driver, "down"], {
          env: { TMPDIR: scratch },
          extendEnv: true,
        }).pipe(Effect.timeout("20 seconds"))
        expect(result.exitCode).toBe(0)
        expect(yield* fs.exists(root)).toBe(false)
        expect(yield* fs.exists(statePath)).toBe(false)
        expect(yield* running(other)).toBe(true)
      }).pipe(
        Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
        Effect.timeout("25 seconds"),
      ),
    30_000,
  )

  it.scopedLive(
    "a wait on a host that does not answer ends with its budget",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const scratch = yield* makeTempDirectoryScoped("gent-gamut-silent-")
        const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
        const host = yield* hostLookalike(path.join(scratch, "run"))
        const { root } = yield* runWith(scratch, driver, host)
        // A socket that takes the call and never answers it.
        const socket = path.join(root, "host.sock")
        yield* spawner.spawn(
          ChildProcess.make("nc", ["-lU", socket], { forceKillAfter: "5 seconds" }),
        )
        yield* pollUntil(fs.exists(socket), (listening) => listening, "the silent socket")
        const [took, result] = yield* runProcess(yield* platform.execPath, [driver, "wait", "2"], {
          env: { TMPDIR: scratch },
          extendEnv: true,
        }).pipe(Effect.timeout("15 seconds"), Effect.timed)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("did not answer within")
        expect(Duration.toMillis(took)).toBeLessThan(10_000)
      }).pipe(
        Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
        Effect.timeout("20 seconds"),
      ),
    25_000,
  )
})

describe("gamut CLI ownership", () => {
  for (const command of ["down", "restart", "send"]) {
    it.scopedLive(
      `a foreign ${command} leaves the host, state and tree untouched`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const platform = yield* GentPlatform
          const scratch = yield* makeTempDirectoryScoped("gent-gamut-owner-")
          const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
          const checkout = path.resolve(path.dirname(driver), "../..")
          const owner = path.join(scratch, "first", "gent")
          const current = path.join(scratch, "second", "gent")
          const copiedDriver = path.join(current, "testbeds", "gamut", "gamut.ts")
          yield* fs.makeDirectory(path.dirname(copiedDriver), { recursive: true })
          yield* fs.makeDirectory(path.join(owner, "apps", "tui", "bin"), { recursive: true })
          yield* fs.copyFile(driver, copiedDriver)
          yield* fs.symlink(path.join(checkout, "node_modules"), path.join(current, "node_modules"))
          const root = path.join(scratch, "run")
          yield* fs.makeDirectory(root)
          const marker = path.join(root, "keep")
          yield* fs.writeFileString(marker, "foreign scratch tree")
          const statePath = path.join(scratch, "gent-gamut-gent.json")
          const state = encodeState({
            root,
            work: root,
            data: root,
            socket: path.join(root, "host.sock"),
            hostPid: 1,
            binary: path.join(owner, "apps", "tui", "bin", "gent"),
            preset: "offline",
            sendMark: 0,
            awaitsTurn: false,
          })
          yield* fs.writeFileString(statePath, state)
          const result = yield* runProcess(
            yield* platform.execPath,
            [copiedDriver, command, "hello"],
            {
              env: {
                TMPDIR: scratch,
                HOME: scratch,
                GENT_DATA_DIR: root,
                GENT_AUTH_DIRECTORY: path.join(scratch, "auth"),
              },
              extendEnv: true,
            },
          )
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain("belongs to another checkout")
          expect(yield* fs.readFileString(statePath)).toBe(state)
          expect(yield* fs.readFileString(marker)).toBe("foreign scratch tree")
        }).pipe(
          Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
          Effect.timeout("8 seconds"),
        ),
      10_000,
    )
  }
})

/**
 * A checkout of its own for `up`: the driver and the fixture copied, the
 * dependencies linked, and `gent` a shell script the host runs in the TUI's
 * place, under an owner home with a user config, an auth directory and
 * another tool's files. Only models.dev and the fixture install are
 * simulated; the host is real. The scope takes the run down and kills a
 * host that outlives it.
 */
const liveRun = (gent: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform
    const scratch = yield* makeTempDirectoryScoped("gent-gamut-host-")
    const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
    const checkout = path.resolve(path.dirname(driver), "../..")
    const current = path.join(scratch, "checkout", "gent")
    const copiedDriver = path.join(current, "testbeds", "gamut", "gamut.ts")
    const binary = path.join(current, "apps", "tui", "bin", "gent")
    yield* fs.makeDirectory(path.dirname(binary), { recursive: true })
    yield* fs.writeFileString(binary, gent)
    yield* fs.chmod(binary, 0o755)
    yield* fs.copy(path.join(checkout, "testbeds", "gamut"), path.dirname(copiedDriver))
    yield* fs.symlink(path.join(checkout, "node_modules"), path.join(current, "node_modules"))
    const owner = path.join(scratch, "owner")
    yield* fs.makeDirectory(path.join(owner, ".gent", "auth"), { recursive: true })
    yield* fs.makeDirectory(path.join(owner, ".claude", "skills"), { recursive: true })
    yield* fs.writeFileString(path.join(owner, ".gent", "config.json"), '{"model":"owner/model"}\n')
    yield* fs.writeFileString(path.join(owner, ".gent", "data.db"), "owner database")
    const body = path.join(scratch, "catalog.json")
    const catalogBody = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Record(
          Schema.String,
          Schema.Struct({ models: Schema.Record(Schema.String, Schema.Struct({})) }),
        ),
      ),
    )({ openai: { models: { "gpt-6.1-sol": {} } } })
    yield* fs.writeFileString(body, catalogBody)
    // Shell scripts: a `#!/usr/bin/env bun` one would run the stand-in `bun`.
    const tools = { curl: `#!/bin/sh\ncat '${body}'\n`, bun: "#!/bin/sh\nexit 0\n" }
    for (const [name, script] of Object.entries(tools)) {
      yield* fs.writeFileString(path.join(scratch, name), script)
      yield* fs.chmod(path.join(scratch, name), 0o755)
    }
    const statePath = path.join(scratch, "gent-gamut-gent.json")
    const execPath = yield* platform.execPath
    const callerPath = yield* Config.String("PATH")
    const gamut = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      runProcess(execPath, [copiedDriver, ...args], {
        env: { PATH: `${scratch}:${callerPath}`, TMPDIR: scratch, HOME: owner, ...env },
        extendEnv: true,
      }).pipe(Effect.timeout("30 seconds"))
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // A state path a test made unreadable reads as no run.
        if (!(yield* fs.exists(statePath).pipe(Effect.orElseSucceed(() => false)))) return
        yield* gamut(["down"]).pipe(Effect.ignore)
      }).pipe(Effect.andThen(reapHostsUnder(scratch)), Effect.orDie),
    )
    const runState = fs.readFileString(statePath).pipe(Effect.map(decodeState))
    return { gamut, runState, statePath, owner, scratch }
  })

// A run can reach five writers of the user config (the first `/model` pick,
// driver overrides, the auth order, a renamed auth slot). The run gives its
// TUI a home of its own, so each writes a copy, never the owner's file.
describe("gamut CLI on a live host", () => {
  it.scopedLive(
    "up runs gent on its own host, in a home of its own, with only the variables it names",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { gamut, runState, statePath, owner } = yield* liveRun(
          `#!/bin/sh\n{ env; printf 'cwd=%s\\n' "$(pwd -P)"; } > "$GENT_DATA_DIR/seen.part"\nmv "$GENT_DATA_DIR/seen.part" "$GENT_DATA_DIR/seen"\nexec sleep 60\n`,
        )
        const up = yield* gamut(["up", "sol", "--no-build"], {
          ANTHROPIC_BASE_URL: "http://localhost:3456",
          GAMUT_TEST_UNLISTED: "the owner's only",
        })
        expect(up.stderr).toBe("")
        expect(up.exitCode).toBe(0)
        const state = yield* runState
        const home = path.join(state.root, "home")
        const seenPath = path.join(state.data, "seen")
        yield* pollUntil(fs.exists(seenPath), (seen) => seen, "the stand-in gent's start")
        const seen = (yield* fs.readFileString(seenPath)).split("\n")
        expect(seen).toContain(`HOME=${home}`)
        expect(seen).toContain(`GENT_DATA_DIR=${state.data}`)
        expect(seen).toContain("ANTHROPIC_BASE_URL=http://localhost:3456")
        expect(seen).toContain(`cwd=${yield* fs.realPath(state.work)}`)
        expect(seen.some((line) => line.startsWith("GAMUT_TEST_UNLISTED="))).toBe(false)
        // The config held the proxy value: the host removed it, and its arguments never had it.
        expect(yield* fs.exists(path.join(state.root, "host.json"))).toBe(false)
        const hostArgs = (yield* runProcess("ps", ["-p", String(state.hostPid), "-o", "args="]))
          .stdout
        expect(hostArgs).toContain("pty-host")
        expect(hostArgs).not.toContain("localhost:3456")
        // The user config is the run's own copy: a write in the run leaves the owner's file as it was.
        const runConfig = path.join(home, ".gent", "config.json")
        const ownerConfig = path.join(owner, ".gent", "config.json")
        expect((yield* fs.stat(runConfig)).type).toBe("File")
        expect(yield* fs.readLink(runConfig).pipe(Effect.option)).toEqual(Option.none())
        expect(yield* fs.readFileString(runConfig)).toBe('{"model":"owner/model"}\n')
        yield* fs.writeFileString(runConfig, '{"model":"picked/in-run"}\n')
        expect(yield* fs.readFileString(ownerConfig)).toBe('{"model":"owner/model"}\n')
        // The login and the other tools' files are the owner's; the database is not.
        expect(yield* fs.readLink(path.join(home, ".gent", "auth"))).toBe(
          path.join(owner, ".gent", "auth"),
        )
        expect(yield* fs.readLink(path.join(home, ".claude"))).toBe(path.join(owner, ".claude"))
        expect(yield* fs.exists(path.join(home, ".gent", "data.db"))).toBe(false)
        const down = yield* gamut(["down"])
        expect(down.exitCode).toBe(0)
        expect(yield* fs.exists(state.root)).toBe(false)
        expect(yield* fs.exists(statePath)).toBe(false)
        expect(
          (yield* runProcess("ps", ["-p", String(state.hostPid), "-o", "pid="])).exitCode,
        ).toBe(1)
      }).pipe(Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer))),
    40_000,
  )

  it.scopedLive(
    "an up that cannot write its state stops the host it started",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { gamut, statePath, scratch } = yield* liveRun(`#!/bin/sh\nexec sleep 60\n`)
        // The state path leads through a regular file, so its write fails
        // once the host is up.
        const blocker = path.join(scratch, "blocker")
        yield* fs.writeFileString(blocker, "")
        yield* fs.symlink(path.join(blocker, "state.json"), statePath)
        const up = yield* gamut(["up", "sol", "--no-build"])
        expect(up.exitCode).toBe(1)
        yield* pollUntil(hostsUnder(scratch), (hosts) => hosts.length === 0, "the host's stop")
      }).pipe(Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer))),
    40_000,
  )

  it.scopedLive(
    "send, read and keys reach the program through the host, and a read after it exits says so",
    () =>
      Effect.gen(function* () {
        const { gamut } = yield* liveRun(
          `#!/bin/sh\nprintf 'ready\\n'\nwhile read line; do echo "got $line"; done\n`,
        )
        expect((yield* gamut(["up", "sol", "--no-build"])).exitCode).toBe(0)
        const screen = gamut(["read", "--full"]).pipe(Effect.map((read) => read.stdout))
        yield* pollUntil(screen, (text) => text.includes("ready"), "the program's first row")
        expect((yield* gamut(["read"])).stdout).toBe("(no change)\n")
        expect((yield* gamut(["send", "hello there"])).exitCode).toBe(0)
        yield* pollUntil(screen, (text) => text.includes("got hello there"), "the sent line")
        expect((yield* gamut(["read"])).stdout).toBe("(no change)\n")
        const refused = yield* gamut(["keys", "nope"])
        expect(refused.exitCode).toBe(1)
        expect(refused.stderr).toContain("no key named nope")
        expect((yield* gamut(["interrupt"])).exitCode).toBe(0)
        yield* pollUntil(screen, (text) => text.includes("(gent exited"), "the program's exit")
        const late = yield* gamut(["send", "too late"])
        expect(late.exitCode).toBe(1)
        expect(late.stderr).toContain("the program exited")
        expect((yield* gamut(["down"])).exitCode).toBe(0)
      }).pipe(Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer))),
    40_000,
  )
})

describe("gamut CLI offline catalog", () => {
  const validBody = Schema.encodeSync(
    Schema.fromJsonString(
      Schema.Record(
        Schema.String,
        Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) }),
      ),
    ),
  )(
    Object.fromEntries(
      Object.entries(catalog).map(([provider, ids]) => [
        provider,
        { models: Object.fromEntries(ids.map((id) => [id, {}])) },
      ]),
    ),
  )
  for (const scenario of [
    {
      name: "the configured chat snapshot resolves presets offline, including its WAL",
      configured: true,
      directory: "configured",
      snapshot: "chat",
      exit: 0,
    },
    {
      name: "the OS-home chat snapshot resolves presets when no data directory is set",
      configured: false,
      directory: ".gent",
      snapshot: "chat",
      exit: 0,
    },
    {
      name: "a missing database preserves the fetch failure",
      configured: true,
      directory: "configured",
      snapshot: "missing",
      exit: 1,
    },
    {
      name: "a decision-only snapshot preserves the fetch failure",
      configured: true,
      directory: "configured",
      snapshot: "decision",
      exit: 1,
    },
    {
      name: "an invalid chat snapshot preserves the fetch failure",
      configured: true,
      directory: "configured",
      snapshot: "invalid",
      exit: 1,
    },
  ]) {
    it.scopedLive(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const platform = yield* GentPlatform
          const scratch = yield* makeTempDirectoryScoped("gent-gamut-catalog-test-")
          const data = path.join(scratch, scenario.directory)
          yield* fs.makeDirectory(data)
          const file = path.join(data, "data.db")
          if (scenario.snapshot !== "missing") {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe("VACUUM INTO '" + file + "'")
            const db = yield* Effect.acquireRelease(
              Effect.sync(() => new Database(file)),
              (opened) => Effect.sync(() => opened.close()),
            )
            yield* Effect.sync(() => {
              db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
              let body = validBody
              if (scenario.snapshot === "invalid") body = '{"openai":{"models":[]}}'
              let source = "api.json"
              if (scenario.snapshot === "decision") source = "api.json?type=decision"
              db.query(
                "INSERT INTO model_catalog_snapshots (source, body, fetched_at, checked_at) VALUES (?, ?, 0, 0)",
              ).run(source, body)
            })
          }
          const originals: Array<{ readonly file: string; readonly body: Uint8Array }> = []
          if (scenario.snapshot !== "missing") {
            for (const original of [file, file + "-wal"]) {
              originals.push({ file: original, body: yield* fs.readFile(original) })
            }
          }
          const curl = path.join(scratch, "curl")
          yield* fs.writeFileString(
            curl,
            "#!/bin/sh\nprintf '%s\\n' 'offline catalog probe' >&2\nexit 7\n",
          )
          yield* fs.chmod(curl, 0o755)
          const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
          const env = Object.fromEntries([
            ["PATH", scratch + ":" + (yield* Config.String("PATH"))],
            ["HOME", scratch],
            ["TMPDIR", scratch],
            ["GENT_AUTH_DIRECTORY", path.join(scratch, "auth")],
          ])
          if (scenario.configured) env["GENT_DATA_DIR"] = data
          const result = yield* runProcess(yield* platform.execPath, [driver, "list"], {
            env,
            extendEnv: false,
          })
          expect(result.exitCode).toBe(scenario.exit)
          if (scenario.exit === 0) {
            expect(result.stdout).toContain("openai/gpt-6-sol:medium")
            expect(result.stdout).toContain("anthropic/claude-opus-5-5:high")
            expect(result.stdout).toContain("using " + file)
          } else {
            expect(result.stderr).toContain("offline catalog probe")
            expect(result.stdout).not.toContain("orchestrator")
          }
          for (const original of originals) {
            expect(yield* fs.readFile(original.file)).toEqual(original.body)
          }
          if (scenario.snapshot === "missing") expect(yield* fs.exists(file)).toBe(false)
          expect(
            (yield* fs.readDirectory(scratch)).filter((name) =>
              name.startsWith("gent-gamut-catalog-"),
            ),
          ).toEqual([])
        }).pipe(
          Effect.provide(Layer.mergeAll(testSqliteStorage, BunGentPlatformLive, BunServices.layer)),
          Effect.timeout("10 seconds"),
        ),
      15_000,
    )
  }
})
