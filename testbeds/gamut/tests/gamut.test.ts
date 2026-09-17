import { describe, expect, test } from "bun:test"
import {
  decodeState,
  isSettled,
  encodeState,
  paneIdFromSplit,
  presetConfigJson,
  PRESETS,
  rewriteRoster,
  rosterBlock,
  shellQuote,
  type GamutState,
} from "../gamut"

const preset = PRESETS["opus-luna"]!

describe("gamut preset config", () => {
  // The exact bytes matter: this is the file gent reads from the work dir.
  test("pins the orchestrator as agent main", () => {
    expect(presetConfigJson(preset)).toBe(
      `{
  "agents": {
    "main": {
      "modelId": "anthropic/claude-opus-5",
      "reasoningEffort": "low"
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
  test("names the worker and reviewer overrides the orchestrator must pass", () => {
    const block = rosterBlock(preset)
    expect(block).toContain("`overrides.modelId` = `openai/gpt-5.6-luna`")
    expect(block).toContain("`overrides.reasoningEffort` = `max`")
    expect(block).toContain("`overrides.modelId` = `anthropic/claude-opus-5`")
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
  const state: GamutState = {
    root: "/tmp/gent-gamut-1",
    work: "/tmp/gent-gamut-1/work",
    data: "/tmp/gent-gamut-1/data",
    pane: "wZ:p9",
    binary: "/checkout/apps/tui/bin/gent",
    preset: "sol-luna",
  }

  test("round trips every field", () => {
    expect(decodeState(encodeState(state))).toEqual(state)
  })

  test("a missing field is refused rather than read as undefined", () => {
    expect(() => decodeState(`{"root":"/tmp/x"}`)).toThrow("work is not a string")
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

describe("a settled pane", () => {
  test("an idle status line with no working child is settled", () => {
    expect(isSettled("  Done.\n\nidle · work (main) · GPT-5.6 Sol · medium   ctx 1%\n")).toBe(true)
  })
  test("an idle root with a working background child is not settled", () => {
    expect(
      isSettled(
        "idle · work (main) · GPT-5.6 Sol\n ◆ main working · Task 2. Read-only audit  ^t agents\n",
      ),
    ).toBe(false)
  })
  test("a generating turn is not settled, whatever words the transcript echoes", () => {
    expect(
      isSettled(
        "┃ Reply with the word idle · ready\n  Generating (3s)\nwork (main) · GPT-5.6 Sol\n",
      ),
    ).toBe(false)
  })
})
