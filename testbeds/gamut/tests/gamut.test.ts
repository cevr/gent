import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
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
  binaryProcessPattern,
  runRecord,
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

  test("every preset resolves against the catalog", () => {
    for (const [name, named] of Object.entries(PRESETS)) {
      const resolved = resolvePreset(named, catalog)
      for (const role of [resolved.orchestrator, resolved.worker, resolved.reviewer]) {
        expect(role.modelId, name).toMatch(/^(anthropic\/claude|openai\/gpt)-/)
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
  // The exact bytes matter: this is the file gent reads from the work dir.
  test("pins the orchestrator as agent main and the worker as agent delegate", () => {
    expect(presetConfigJson(preset)).toBe(
      `{
  "agents": {
    "main": {
      "modelId": "anthropic/claude-opus-5-5",
      "reasoningEffort": "low"
    },
    "delegate": {
      "modelId": "openai/gpt-6-luna",
      "reasoningEffort": "max"
    }
  }
}
`,
    )
  })

  test("every preset names a model for all three roles", () => {
    for (const [name, entry] of Object.entries(PRESETS)) {
      for (const role of [entry.orchestrator, entry.worker, entry.reviewer]) {
        expect(role.modelId, name).toMatch(/^(anthropic|openai)\//)
        expect(role.reasoningEffort, name).not.toBe("")
      }
    }
  })
})

describe("gamut roster block", () => {
  test("names the paired worker and the reviewer overrides the orchestrator must pass", () => {
    const block = rosterBlock(preset)
    expect(block).toContain("paired in `.gent/config.json` as `openai/gpt-6-luna` at `max`")
    expect(block).not.toContain("`overrides.modelId` = `openai/gpt-6-luna`")
    expect(block).toContain("`overrides.modelId` = `anthropic/claude-opus-5-5`")
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

  test("a state file from before any send reads its send mark as zero, awaiting a turn", () => {
    const { sendMark: _mark, awaitsTurn: _awaits, ...older } = state
    const decoded = decodeState(JSON.stringify(older))
    expect(decoded.sendMark).toBe(0)
    expect(decoded.awaitsTurn).toBe(true)
  })

  test("a missing field is refused rather than read as undefined", () => {
    expect(() => decodeState(`{"root":"/tmp/x"}`)).toThrow('Missing key\n  at ["work"]')
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
  test("an idle root with a working background child is not settled", () => {
    const pane =
      "idle · work (main) · GPT-5.6 Sol\n ◆ main working · Task 2. Read-only audit  ^t agents\n"
    expect(settlesAt(repeated(pane, finished, 10), true)).toBe(-1)
  })
  test("a generating turn is not settled, whatever words the transcript echoes", () => {
    const pane =
      "┃ Reply with the word idle · ready\n  Generating (3s)\nwork (main) · GPT-5.6 Sol\n"
    expect(settlesAt(repeated(pane, finished, 10), true)).toBe(-1)
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
      ...repeated("  Generating (1s)\n", queued, 2),
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
      ["  Generating (1s)\n", quiet] as const,
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
    ])
    expect(openTurnSessions(db)).toEqual([])
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

describe("gamut process match", () => {
  const binary = "/Users/me/.rifts/gent/x/apps/tui/bin/gent"
  const matches = (commandLine: string) =>
    new RegExp(binaryProcessPattern(binary)).test(commandLine)
  test("matches the TUI however it was launched", () => {
    expect(matches(binary)).toBe(true)
    expect(matches(`${binary} -p 'fix the suite'`)).toBe(true)
    expect(matches(`${binary} resume`)).toBe(true)
  })
  test("does not match the gent-cell sibling or another checkout's binary", () => {
    expect(matches(`${binary}-cell`)).toBe(false)
    expect(matches(binary.replace(".rifts", "Xrifts"))).toBe(false)
    expect(matches(`/bin/sh -c ${binary}`)).toBe(false)
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
