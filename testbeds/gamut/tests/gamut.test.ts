import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  decodeState,
  failureText,
  isSettled,
  latestEventId,
  openTurnSessions,
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

const preset = PRESETS["opus-luna"]!

describe("gamut preset config", () => {
  // The exact bytes matter: this is the file gent reads from the work dir.
  test("pins the orchestrator as agent main and the worker as agent delegate", () => {
    expect(presetConfigJson(preset)).toBe(
      `{
  "agents": {
    "main": {
      "modelId": "anthropic/claude-opus-5",
      "reasoningEffort": "low"
    },
    "delegate": {
      "modelId": "openai/gpt-5.6-luna",
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
    expect(block).toContain("paired in `.gent/config.json` as `openai/gpt-5.6-luna` at `max`")
    expect(block).not.toContain("`overrides.modelId` = `openai/gpt-5.6-luna`")
    expect(block).toContain("`overrides.modelId` = `anthropic/claude-opus-5`")
    expect(block).toContain("`overrides.reasoningEffort` = `high`")
  })

  test("a rewrite replaces only the block and keeps the prose around it", () => {
    const before =
      "# rules\n\nprose above\n\n<!-- roster -->\n- stale\n<!-- /roster -->\n\nprose below\n"
    const after = rewriteRoster(before, preset)
    expect(after).toContain("prose above")
    expect(after).toContain("prose below")
    expect(after).not.toContain("- stale")
    expect(after).toContain("openai/gpt-5.6-luna")
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
  }

  test("round trips every field", () => {
    expect(decodeState(encodeState(state))).toEqual(state)
  })

  test("a state file from before any send reads its send mark as zero", () => {
    const { sendMark: _mark, ...older } = state
    expect(decodeState(JSON.stringify(older)).sendMark).toBe(0)
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
  const finished = { started: true, open: [] }
  test("an idle status line with every turn ended is settled", () => {
    expect(
      isSettled("  Done.\n\nidle · work (main) · GPT-5.6 Sol · medium   ctx 1%\n", finished),
    ).toBe(true)
  })
  // The footer's first slot holds a held error or an extension notice in
  // place of the phase word (apps/tui/src/app.tsx, phaseLabels).
  test("a held error in the footer still settles once every turn has ended", () => {
    expect(
      isSettled("  Done.\n\nprovider rejected the key · work (main) · GPT-5.6 Sol\n", finished),
    ).toBe(true)
  })
  test("an extension notice in the footer still settles once every turn has ended", () => {
    expect(isSettled("wake alarm set for 10:00 · work (main) · GPT-5.6 Sol\n", finished)).toBe(true)
  })
  test("an idle root with a working background child is not settled", () => {
    expect(
      isSettled(
        "idle · work (main) · GPT-5.6 Sol\n ◆ main working · Task 2. Read-only audit  ^t agents\n",
        finished,
      ),
    ).toBe(false)
  })
  test("a generating turn is not settled, whatever words the transcript echoes", () => {
    expect(
      isSettled(
        "┃ Reply with the word idle · ready\n  Generating (3s)\nwork (main) · GPT-5.6 Sol\n",
        finished,
      ),
    ).toBe(false)
  })
  test("an open turn in the record is not settled, whatever the pane shows", () => {
    expect(isSettled("idle · work (main)\n", { started: true, open: ["child"] })).toBe(false)
  })
  test("a run with no turn started yet is not settled", () => {
    expect(isSettled("ready · work (main)\n", { started: false, open: [] })).toBe(false)
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
    expect(runRecord(withEvents([]), 0)).toEqual({ started: false, open: [] })
    expect(runRecord(withEvents([["s", "MessageReceived"]]), 0)).toEqual({
      started: true,
      open: ["s"],
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
    expect(runRecord(db, 2)).toEqual({ started: false, open: [] })
    insert(db, "s", "MessageReceived")
    expect(runRecord(db, 2)).toEqual({ started: true, open: ["s"] })
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
    expect(runRecord(db, 4)).toEqual({ started: false, open: [] })
  })
  test("a stream that started after the send mark counts as a started turn", () => {
    const db = withEvents([
      ["s", "TurnCompleted"],
      ["s", "StreamStarted"],
    ])
    expect(runRecord(db, 1)).toEqual({ started: true, open: ["s"] })
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
})
