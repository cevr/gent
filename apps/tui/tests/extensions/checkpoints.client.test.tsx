/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { DateTime, Effect, Option, Schema } from "effect"
import type { CheckpointListType, RevertOutcomeType } from "@gent/extensions/client"
import { BranchId, MessageId } from "@gent/core/protocol"
import checkpointsClient, {
  actionEntries,
  refusalText,
  turnEntry,
  turnLine,
} from "../../src/extensions/checkpoints.client"
import type { ClientActivitySnapshot } from "../../src/extensions/client-facets"
import { createMockClient, renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import {
  makeClientTestTransport,
  makePaneSlot,
  provideClientServices,
} from "../extension-test-harness-boundary"

// ── revert pane ─────────────────────────────────────────────────────────────

/**
 * The `/revert` pane: one row per turn of the branch in view, the undo row
 * over them after a revert, and the keys that revert files and conversation,
 * files only, or write past a refusal.
 */

type TurnRow = CheckpointListType["turns"][number]

const MINUTE = 60_000
const NOW = 10 * 24 * 60 * MINUTE

const turn = (n: number, prompt: string, state: TurnRow["state"], ago: number): TurnRow => ({
  n,
  messageId: MessageId.make(`message-${n}`),
  prompt,
  createdAt: NOW - ago,
  state,
  files: 2,
  insertions: 12,
  deletions: 3,
})

const parser = turn(1, "fix the parser so it reads nested lists", "captured", 12 * MINUTE)
const readOnly = turn(2, "explain the module", "none", 30 * MINUTE)
const first = turn(3, "add the lexer", "captured", 2 * 60 * MINUTE)
const list: CheckpointListType = { turns: [parser, readOnly, first] }

describe("revert pane rows", () => {
  test("a turn row names its number, prompt, change and age; a narrow row drops the age, then cuts the prompt", () => {
    expect(turnLine(parser, 120, NOW)).toBe(
      "#1 · fix the parser so it reads nested lists · +12 -3 in 2 files · 12m",
    )
    expect(turnLine(parser, 50, NOW)).toBe("#1 · fix the parser so … · +12 -3 in 2 files · 12m")
    expect(turnLine(parser, 40, NOW)).toBe("#1 · fix the parser… · +12 -3 in 2 files")
    expect(turnLine(readOnly, 120, NOW)).toBe(
      "#2 · explain the module · no checkpoint: no tool wrote in it · 30m",
    )
    expect(turnLine({ ...parser, state: "open" }, 120, NOW)).toBe(
      "#1 · fix the parser so it reads nested lists · no end yet · 12m",
    )
  })

  test("a turn with no checkpoint cannot be chosen; undo and finish rows come first", () => {
    expect(Option.isNone(turnEntry(readOnly))).toBe(true)
    expect(Option.map(turnEntry(parser), (entry) => [entry.enter, entry.filesOnly])).toEqual(
      Option.some([
        { _tag: "Turn", n: 1, conversation: true },
        Option.some({ _tag: "Turn", n: 1, conversation: false }),
      ]),
    )
    expect(actionEntries(list)).toEqual([])
    const undone = actionEntries({ ...list, undo: { requestId: "r-1", files: 3 } })
    expect(undone.map((entry) => [entry.enter._tag, entry.line(80, NOW)])).toEqual([
      ["Undo", "↶ undo the last revert · 3 files written back"],
    ])
    const cut = actionEntries({ ...list, unfinished: { requestId: "r-2" } })
    expect(cut.map((entry) => entry.enter._tag)).toEqual(["Finish", "Undo"])
    expect(refusalText("others also changed 1 of the files", ["a.txt"])).toBe(
      "others also changed 1 of the files · a.txt",
    )
  })
})

/** What the pane asked and what the shell was told. */
interface PaneLog {
  readonly requests: Array<{ readonly capabilityId: string; readonly input: unknown }>
  readonly notes: Array<string>
  readonly switched: Array<{ readonly branchId: string; readonly name: string }>
}

/**
 * The pane over a server whose `checkpoints.list` answers `listed` and whose
 * `checkpoints.revert` answers `outcomes` in order; `state` is the session's.
 */
const openPane = (
  width: number,
  listed: CheckpointListType,
  outcomes: ReadonlyArray<RevertOutcomeType> = [],
  state: ClientActivitySnapshot["state"] = "idle",
) =>
  Effect.gen(function* () {
    const log: PaneLog = { requests: [], notes: [], switched: [] }
    const answers = [...outcomes]
    const client = createMockClient({
      extension: {
        request: (request: { readonly capabilityId: string; readonly input: unknown }) =>
          Effect.sync(() => {
            log.requests.push({ capabilityId: request.capabilityId, input: request.input })
            if (request.capabilityId === "checkpoints.list") return listed
            return answers.shift()
          }),
      },
      session: { thread: () => Effect.succeed([{ id: "test-session", name: "Parser work" }]) },
    })
    const contributions = yield* provideClientServices(checkpointsClient.setup, {
      transport: { ...makeClientTestTransport(), client },
      shell: {
        pane: makePaneSlot(),
        notify: (message) => {
          log.notes.push(message)
        },
        switchSession: (input) => {
          log.switched.push({ branchId: input.branchId, name: input.name })
        },
      },
      activity: () => ({ state }),
    })
    const command = Option.getOrThrow(Option.fromUndefinedOr(contributions.commands?.[0]))
    const widget = Option.getOrThrow(Option.fromUndefinedOr(contributions.widgets?.[0]))
    expect(command.slash).toBe("revert")
    const Pane = widget.component
    const setup = yield* renderScoped(() => <Pane />, { width, height: 30 })
    command.onSelect()
    yield* waitForFrame(setup, (frame) => frame.includes("#1 ·"), "the revert pane")
    return { setup, log }
  })

const reverts = (log: PaneLog) =>
  log.requests.filter((request) => request.capabilityId === "checkpoints.revert")

/** A revert request's id, as the pane sent it. */
const requestIdOf = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }))

describe("revert pane", () => {
  it.scopedLive(
    "lists the turns at 120 and 44 columns; enter reverts files and conversation and moves to the new branch",
    () =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
        const fresh: CheckpointListType = {
          turns: list.turns.map((row) => ({ ...row, createdAt: now - (NOW - row.createdAt) })),
        }
        const { setup, log } = yield* openPane(120, fresh, [
          { _tag: "Reverted", files: ["a.txt", "b.txt"], branchId: BranchId.make("branch-fork") },
        ])
        const wide = renderFrame(setup)
        expect(wide).toContain("Revert · 3 turns")
        expect(wide).toContain(
          "#1 · fix the parser so it reads nested lists · +12 -3 in 2 files · 12m",
        )
        expect(wide).toContain("#2 · explain the module · no checkpoint")
        expect(wide).toContain("review: /diff turn 1 · conversation only: /fork")
        expect(wide).toContain("f files only")
        setup.resize(44, 30)
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("#1 · fix the parser") && !frame.includes("· 12m"),
          "the narrow rows",
        )
        setup.mockInput.pressEnter()
        yield* waitUntil(() => log.switched.length > 0, "the switch to the new branch")
        expect(reverts(log).map((request) => request.input)).toMatchObject([
          { action: { _tag: "Turn", n: 1, conversation: true }, overwrite: false },
        ])
        expect(log.switched).toEqual([{ branchId: "branch-fork", name: "Parser work" }])
        expect(log.notes).toEqual(["reverted 2 files to before turn #1 · /revert to undo"])
        yield* waitForFrame(setup, (frame) => !frame.includes("Revert ·"), "the pane closed")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "f reverts files only; a refusal names the paths, and o writes them with the same request",
    () =>
      Effect.gen(function* () {
        const { setup, log } = yield* openPane(120, list, [
          {
            _tag: "Refused",
            reason: "others also changed 1 of the files to revert",
            conflicts: ["a.txt"],
          },
          { _tag: "Reverted", files: ["a.txt"] },
        ])
        setup.mockInput.pressKey("f")
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("others also changed 1 of the files to revert · a.txt"),
          "the refusal",
        )
        expect(renderFrame(setup)).toContain("o overwrite")
        setup.mockInput.pressKey("o")
        yield* waitUntil(() => log.notes.length > 0, "the overwrite's note")
        const [refused, written] = reverts(log).map((request) => request.input)
        expect(refused).toMatchObject({
          action: { _tag: "Turn", n: 1, conversation: false },
          overwrite: false,
        })
        expect(written).toMatchObject({
          action: { _tag: "Turn", n: 1, conversation: false },
          overwrite: true,
        })
        // The refused request wrote nothing, so the overwrite reuses its id.
        expect(requestIdOf(written)).toEqual(requestIdOf(refused))
        expect(Option.isSome(requestIdOf(refused))).toBe(true)
        expect(log.switched).toEqual([])
        expect(log.notes).toEqual(["reverted 1 file to before turn #1 · /revert to undo"])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("while the session runs a turn the pane refuses at once and asks nothing", () =>
    Effect.gen(function* () {
      const { setup, log } = yield* openPane(120, list, [], "working")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("stop the turn first (Esc)"), "refusal")
      expect(reverts(log)).toEqual([])
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("Revert ·"), "esc closes")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("after a revert the top row undoes it", () =>
    Effect.gen(function* () {
      const { setup, log } = yield* openPane(
        120,
        { ...list, undo: { requestId: "r-1", files: 2 } },
        [{ _tag: "Reverted", files: ["a.txt", "b.txt"] }],
      )
      yield* waitForFrame(setup, (frame) => frame.includes("↶ undo the last revert"), "undo row")
      setup.mockInput.pressEnter()
      yield* waitUntil(() => log.notes.length > 0, "the undo's note")
      expect(reverts(log).map((request) => request.input)).toMatchObject([
        { action: { _tag: "Undo" } },
      ])
      expect(log.notes).toEqual(["undid the last revert: 2 files written back"])
    }).pipe(Effect.timeout("10 seconds")),
  )
})
