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
import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { it } from "effect-bun-test"
import {
  decodeState,
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
  runRecord,
  sessionStatuses,
  userMessageTexts,
  paneIdFromSplit,
  presetConfigJson,
  PRESETS,
  rewriteRoster,
  rosterBlock,
  shellQuote,
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
  ],
  openai: ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-pro", "gpt-5.6-sol", "gpt-6-sol"],
}

const preset = resolvePreset(PRESETS["opus-luna"]!, catalog)

describe("gamut model families", () => {
  test("a family resolves to its newest release, not a snapshot or a variant", () => {
    expect(newestInFamily("anthropic/opus", catalog.anthropic)).toBe("anthropic/claude-opus-5-5")
    expect(newestInFamily("anthropic/sonnet", catalog.anthropic)).toBe("anthropic/claude-sonnet-5")
    expect(newestInFamily("anthropic/fable", catalog.anthropic)).toBe("anthropic/claude-fable-5-1")
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
  test("pins the orchestrator as agent main and the worker as agent delegate", () => {
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
  }
}
`,
    )
  })
})

describe("gamut roster block", () => {
  test("names the paired worker and the reviewer overrides the orchestrator must pass", () => {
    const block = rosterBlock(preset)
    expect(block).toContain("paired in `.gent/config.json` as `openai/gpt-6-luna` at `max`")
    expect(block).toContain("Repetitive mechanical changes following an established pattern only")
    expect(block).toContain("`overrides.model` = `openai/gpt-6-luna`")
    expect(block).toContain("`overrides.model` = `anthropic/claude-opus-5-5`")
    expect(block).not.toContain("modelId")
    expect(block).toContain("`overrides.reasoningEffort` = `high`")
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
    pane: "wZ:p9",
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

describe("gamut shell quoting", () => {
  // The pane's shell re-splits the command line, so an unquoted prompt with
  // spaces reached gent as several positional arguments and was rejected.
  test("a prompt with spaces stays one argument", () => {
    expect(shellQuote("Reply with the single word ready.")).toBe(
      "'Reply with the single word ready.'",
    )
  })

  test("an embedded single quote is escaped, not left to close the quote", () => {
    expect(shellQuote("don't stop")).toBe(`'don'\\''t stop'`)
  })
})

describe("gamut pane id", () => {
  test("reads the pane id out of a herdr split reply", () => {
    expect(
      paneIdFromSplit(
        `{"id":"cli:pane:split","result":{"pane":{"pane_id":"wZ:pH"},"type":"pane"}}`,
      ),
    ).toBe("wZ:pH")
  })

  test("a reply with no pane id is refused", () => {
    expect(() => paneIdFromSplit(`{"result":{}}`)).toThrow("no pane id")
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
      const pane = `idle · work (main) · GPT-5.6 Sol\n ${pulse} delegate: Task 2. Read-only audit · Reading src  ctrl+t sessions\n`
      expect(settlesAt(repeated(pane, finished, 10), true)).toBe(-1)
    }
  })
  test("an idle root whose tray shows only a done thread settles", () => {
    const pane = "  Done.\n\nidle · work (main) · GPT-5.6 Sol\n ◆ release notes  ctrl+t sessions\n"
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
      [`${idlePane} ◇ delegate: audit  ctrl+t sessions\n`, quiet] as const,
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
  test("a herdr error reply gives its message", () => {
    const reply = `{"id":"cli:pane:current","error":{"code":"server_not_running","message":"no herdr server is running"}}`
    expect(failureText("", reply)).toBe("no herdr server is running")
    expect(failureText(reply, "")).toBe("no herdr server is running")
  })
  test("another command gives its last stderr line, then its last stdout line", () => {
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
      build: true,
    })
    expect(parseUpArgs(["--prompt", "fix it", "opus-luna", "--no-build"])).toEqual({
      preset: "opus-luna",
      prompt: "fix it",
      build: false,
    })
  })
  test("a prompt that names the preset is still the prompt", () => {
    expect(parseUpArgs(["mixed", "--prompt", "mixed"])).toEqual({
      preset: "mixed",
      prompt: "mixed",
      build: true,
    })
  })
  test("--prompt with no value is refused, not replaced by the default prompt", () => {
    expect(() => parseUpArgs(["mixed", "--prompt"])).toThrow("--prompt needs a value")
    expect(() => parseUpArgs(["mixed", "--prompt", "--no-build"])).toThrow("--prompt needs a value")
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
        // oxlint-disable-next-line effect/noGlobals -- a raw SQLite row for the driver's queries, as the stored JSON spells it
        JSON.stringify({ _tag: "ExtensionStateChanged", extensionId }),
      ])
    expect(extensionPulses(db)).toEqual([])
    for (const id of ["@gent/delegate", "@gent/btw", "@gent/btw", "@gent/btw"]) pulse(id)
    db.run("INSERT INTO events (event_tag, event_json) VALUES ('StreamStarted', '{}')")
    expect(extensionPulses(db)).toEqual([
      { extension: "@gent/btw", count: 3 },
      { extension: "@gent/delegate", count: 1 },
    ])
  })
})

describe("gamut reads the schema gent migrates", () => {
  // SQLite prepares each query as it runs, so a table or a column the
  // migrated schema lacks fails the read here, not in the next live run.
  it.live("every status and wait query runs on a freshly migrated database", () =>
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
      expect(openTurnSessions(db)).toEqual([])
      expect(runRecord(db, 0)).toEqual({ started: false, open: [], stored: false })
      expect(latestEventId(db)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(testSqliteStorage), Effect.timeout("10 seconds")),
  )
})

describe("gamut CLI cleanup", () => {
  const missingPane =
    '#!/usr/bin/env bun\nconsole.log(\'{"error":{"code":"pane_not_found","message":"pane not found"}}\')\nprocess.exit(1)\n'
  const stalledHerdr =
    "#!/usr/bin/env bun\nrequire('node:fs').writeFileSync(process.env.HERDR_TEST_PID, String(process.pid))\nawait Bun.sleep(60000)\n"
  for (const scenario of [
    {
      name: "a closed pane allows cleanup",
      command: "down",
      herdr: missingPane,
      stalled: false,
      exit: 0,
      kept: false,
    },
    {
      name: "a closed pane cannot restart",
      command: "restart",
      herdr: missingPane,
      stalled: false,
      exit: 1,
      kept: true,
    },
    {
      name: "a stalled Herdr process is reaped at the quit deadline",
      command: "down",
      herdr: stalledHerdr,
      stalled: true,
      exit: 1,
      kept: true,
    },
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
          const herdrPath = path.join(scratch, "herdr")
          const pidPath = path.join(scratch, "herdr-pid")
          const statePath = path.join(
            scratch,
            `gent-gamut-${path.basename(path.resolve(path.dirname(driver), "../.."))}.json`,
          )
          yield* fs.makeDirectory(root)
          // Only the external Herdr boundary is simulated; Gamut runs as a real CLI over real files/processes.
          yield* fs.writeFileString(herdrPath, scenario.herdr)
          yield* fs.chmod(herdrPath, 0o755)
          // Reap the test-owned boundary process even when the old driver hangs and the outer timeout fires.
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.gen(function* () {
              if (!(yield* fs.exists(pidPath))) return
              const pid = yield* fs.readFileString(pidPath)
              const child = yield* runProcess("ps", ["-p", pid, "-o", "args="])
              if (child.stdout.includes(herdrPath)) {
                const number = yield* Schema.decodeEffect(Schema.FiniteFromString)(pid)
                yield* platform.signal(number, "SIGKILL").pipe(Effect.ignore)
              }
            }).pipe(Effect.orDie),
          )
          yield* fs.writeFileString(
            statePath,
            encodeState({
              root,
              work: root,
              data: root,
              pane: "wTest:closed",
              binary: path.join(path.resolve(path.dirname(driver), "../.."), "apps/tui/bin/gent"),
              preset: "offline",
              sendMark: 0,
              awaitsTurn: false,
            }),
          )
          const result = yield* runProcess(yield* platform.execPath, [driver, scenario.command], {
            env: {
              PATH: `${scratch}:${yield* Config.String("PATH")}`,
              TMPDIR: scratch,
              HERDR_TEST_PID: pidPath,
            },
            extendEnv: true,
          }).pipe(Effect.timeout("22 seconds"))
          expect(result.exitCode).toBe(scenario.exit)
          expect(yield* fs.exists(root)).toBe(scenario.kept)
          expect(yield* fs.exists(statePath)).toBe(scenario.kept)
          if (scenario.stalled) {
            expect(result.stderr).toContain("quit timed out after 15s")
            const pid = yield* fs.readFileString(pidPath)
            expect((yield* runProcess("ps", ["-p", pid, "-o", "pid="])).exitCode).toBe(1)
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
          Effect.timeout("25 seconds"),
        ),
      30_000,
    )
  }
})

describe("gamut CLI ownership", () => {
  for (const command of ["down", "restart", "send"]) {
    it.scopedLive(
      `a foreign ${command} leaves the pane, state and tree untouched`,
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
            pane: "wTest:foreign",
            binary: path.join(owner, "apps", "tui", "bin", "gent"),
            preset: "offline",
            sendMark: 0,
            awaitsTurn: false,
          })
          yield* fs.writeFileString(statePath, state)
          const calls = path.join(scratch, "calls")
          const herdr = path.join(scratch, "herdr")
          yield* fs.writeFileString(
            herdr,
            '#!/usr/bin/env bun\nrequire(\'node:fs\').appendFileSync(process.env.HERDR_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + \'\\n\')\nif (process.argv.includes(\'process-info\')) { console.log(\'{"error":{"code":"pane_not_found","message":"pane not found"}}\'); process.exit(1) }\n',
          )
          yield* fs.chmod(herdr, 0o755)
          const result = yield* runProcess(
            yield* platform.execPath,
            [copiedDriver, command, "hello"],
            {
              env: {
                PATH: scratch + ":" + (yield* Config.String("PATH")),
                TMPDIR: scratch,
                HOME: scratch,
                GENT_DATA_DIR: root,
                GENT_AUTH_DIRECTORY: path.join(scratch, "auth"),
                HERDR_TEST_CALLS: calls,
              },
              extendEnv: true,
            },
          )
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain("belongs to another checkout")
          expect(yield* fs.exists(calls)).toBe(false)
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

// A pane can reach five writers of the user config (the first `/model` pick,
// driver overrides, the auth order, a renamed auth slot). The run gives its
// pane a home of its own, so each writes a copy, never the owner's file.
describe("gamut CLI pane home", () => {
  it.scopedLive(
    "up gives the pane a home whose user config is a copy, with the owner's other files linked",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const scratch = yield* makeTempDirectoryScoped("gent-gamut-home-")
        const driver = yield* path.fromFileUrl(new URL("../gamut.ts", import.meta.url))
        const checkout = path.resolve(path.dirname(driver), "../..")
        // A checkout of its own: the driver, the fixture and a stand-in binary.
        const current = path.join(scratch, "checkout", "gent")
        const copiedDriver = path.join(current, "testbeds", "gamut", "gamut.ts")
        yield* fs.makeDirectory(path.join(current, "apps", "tui", "bin"), { recursive: true })
        yield* fs.writeFileString(path.join(current, "apps", "tui", "bin", "gent"), "")
        yield* fs.copy(path.join(checkout, "testbeds", "gamut"), path.dirname(copiedDriver))
        yield* fs.symlink(path.join(checkout, "node_modules"), path.join(current, "node_modules"))
        // The owner's home: a user config, an auth directory and another tool's files.
        const owner = path.join(scratch, "owner")
        const ownerConfig = path.join(owner, ".gent", "config.json")
        yield* fs.makeDirectory(path.join(owner, ".gent", "auth"), { recursive: true })
        yield* fs.makeDirectory(path.join(owner, ".claude", "skills"), { recursive: true })
        yield* fs.writeFileString(ownerConfig, '{"model":"owner/model"}\n')
        yield* fs.writeFileString(path.join(owner, ".gent", "data.db"), "owner database")
        // Only the external boundaries are simulated: herdr, models.dev and the fixture install.
        const calls = path.join(scratch, "calls")
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
        const tools = {
          herdr: `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase " $* " in *" split "*) printf '%s\\n' '{"result":{"pane":{"pane_id":"wT:p1"}}}' ;; esac\n`,
          curl: `#!/bin/sh\ncat '${body}'\n`,
          bun: "#!/bin/sh\nexit 0\n",
        }
        for (const [name, script] of Object.entries(tools)) {
          yield* fs.writeFileString(path.join(scratch, name), script)
          yield* fs.chmod(path.join(scratch, name), 0o755)
        }
        const result = yield* runProcess(
          yield* platform.execPath,
          [copiedDriver, "up", "sol", "--no-build"],
          {
            env: {
              PATH: scratch + ":" + (yield* Config.String("PATH")),
              TMPDIR: scratch,
              HOME: owner,
            },
            extendEnv: true,
          },
        )
        expect(result.stderr).toBe("")
        expect(result.exitCode).toBe(0)
        const state = decodeState(
          yield* fs.readFileString(path.join(scratch, "gent-gamut-gent.json")),
        )
        const home = path.join(state.root, "home")
        const split = (yield* fs.readFileString(calls))
          .split("\n")
          .filter((line) => line.startsWith("pane split "))
        expect(split).toHaveLength(1)
        expect(split[0]).toContain(` --env HOME=${home}`)
        expect(split[0]).toContain(` --env GENT_DATA_DIR=${state.data}`)
        // The user config is the run's own copy: a pane write leaves the owner's file as it was.
        const paneConfig = path.join(home, ".gent", "config.json")
        expect((yield* fs.stat(paneConfig)).type).toBe("File")
        expect(yield* fs.readLink(paneConfig).pipe(Effect.option)).toEqual(Option.none())
        expect(yield* fs.readFileString(paneConfig)).toBe('{"model":"owner/model"}\n')
        yield* fs.writeFileString(paneConfig, '{"model":"picked/in-pane"}\n')
        expect(yield* fs.readFileString(ownerConfig)).toBe('{"model":"owner/model"}\n')
        // The login and the other tools' files are the owner's; the database is not.
        expect(yield* fs.readLink(path.join(home, ".gent", "auth"))).toBe(
          path.join(owner, ".gent", "auth"),
        )
        expect(yield* fs.readLink(path.join(home, ".claude"))).toBe(path.join(owner, ".claude"))
        expect(yield* fs.exists(path.join(home, ".gent", "data.db"))).toBe(false)
      }).pipe(
        Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
        Effect.timeout("20 seconds"),
      ),
    25_000,
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
