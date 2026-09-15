/** @jsxImportSource @opentui/solid */
/**
 * The ruled frame the docked panes share.
 *
 * `/model`, `/think` and `/thread` draw the same `PickerFrame` the
 * slash-command popup does: ruled off top and bottom under the composer, not
 * a bordered box. These pin the two things that framing decides — the rows a
 * pane keeps to the height rule, and the columns a row may spend.
 *
 * The column budget is the part that has broken twice. A row pads itself one
 * column and sits inside a body that pads one each side, so a row ends one
 * column inside the rule. Budget it wider and the right-aligned tail wraps
 * onto a line of its own; budget it narrower and every row is cut short.
 */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Option } from "effect"
import { BranchId, Model, ModelId, ProviderId, SessionId } from "@gent/core/protocol"
import { modelRows, SettingsPicker } from "../../src/components/settings-picker"
import { pickerHeight, pickerLines, usePickerGeometry } from "../../src/components/picker-frame"
import { ThreadPane, type ThreadWindow } from "../../src/extensions/builtins/thread-view.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const sessionId = SessionId.make("s1")
const branchId = BranchId.make("s1-branch")

/** Rows the frame occupies: its top rule through its footer. */
const renderedFrameRows = (frame: string): number => {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.startsWith("────"))
  const bottom = lines.findLastIndex((line) => line.startsWith("────"))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(bottom).toBeGreaterThan(top)
  // The footer draws below the closing rule.
  return bottom - top + 2
}

const ruleWidth = (lines: ReadonlyArray<string>): number =>
  Option.getOrThrow(Option.fromNullishOr(lines.find((line) => line.startsWith("────")))).trimEnd()
    .length

/**
 * A window whose age renders, so a row can actually overflow its budget.
 *
 * The age is the only part of a thread row drawn against the right edge. A
 * fixture that leaves `updatedAt` at zero draws an empty age column, and no
 * row can overflow however long its preview is — which is exactly how the
 * agents pane shipped a visibly wrapping row past a green width test.
 */
const agedWindow = (updatedAt: number): ThreadWindow => ({
  sessionId,
  branchId,
  sessionName: "Session s1",
  index: 1,
  firstMessageId: "u1",
  lastMessageId: "a1",
  count: 2,
  summary: Option.none(),
  summarizedCount: 0,
  omittedCount: 0,
  preview: "P".repeat(300),
  updatedAt,
})

const wideModel = new Model({
  id: ModelId.make("D".repeat(150)),
  name: "N".repeat(150),
  provider: ProviderId.make("test"),
})

describe("picker height rule", () => {
  it.live("counts the lines a pane draws, not the items it holds", () => {
    // A flat list spends one line per item; a pane that opens groups with
    // headings and closes with a detail line spends more, and counting items
    // alone would starve its body.
    expect(pickerLines(0, 1)).toBe(0)
    expect(pickerLines(3, 0)).toBe(3)
    expect(pickerLines(3, 1)).toBe(4)
    // Six rows is the cap, plus the frame's own five lines of chrome.
    expect(pickerHeight(pickerLines(20, 1), 40)).toBe(11)
    return Effect.void
  })
})

describe("docked panes", () => {
  it.live("the thread pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ThreadPane
              open={true}
              controller={{
                windows: () => [agedWindow(0)],
                sessions: () => 1,
                current: () => Option.some({ sessionId, branchId }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("open session"), "thread pane"),
      )
      // One heading, one window, one detail line: three drawn lines.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(pickerLines(2, 1), 40))
    }),
  )

  it.live("the settings pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <SettingsPicker
              open={true}
              title="Model"
              rows={modelRows([wideModel])}
              current={Option.none()}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Model · 1"), "settings pane"),
      )
      // One row plus the query row above it.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(pickerLines(1, 1), 40))
    }),
  )
})

describe("docked pane column budget", () => {
  it.live("a thread row keeps its age on the row, one column inside the rule", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ThreadPane
              open={true}
              controller={{
                windows: () => [agedWindow(now - 2 * 24 * 60 * 60 * 1000)],
                sessions: () => 1,
                current: () => Option.some({ sessionId, branchId }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 58, height: 30 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("PPP"), "thread row"),
      )
      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("PPP"))

      // The preview and the age share one line: the age never wraps alone.
      expect(rowLines.length).toBe(1)
      expect(rowLines[0]).toContain("2d")
      expect(lines.some((line) => line.trim() === "2d")).toBe(false)
      // A cut row ends one column inside the rule.
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )

  it.live("a settings row spends the picker's columns, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The drawn row cannot witness an overspent budget: the row box clamps
      // its text, so a row budgeted four columns too wide still draws one
      // unwrapped line. The budget itself is the only place the spend stays
      // visible, and the wrap follows from it — the same reason the agents
      // pane pins these numbers rather than a rendered length.
      const seen: Array<{ row: number; section: number }> = []
      const Probe = () => {
        const { rowWidth, sectionWidth } = usePickerGeometry()
        seen.push({ row: rowWidth(), section: sectionWidth() })
        return <text>probe</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <Probe />
              <SettingsPicker
                open={true}
                title="Model"
                rows={modelRows([wideModel])}
                current={Option.none()}
                onSelect={() => {}}
                onClose={() => {}}
              />
            </>
          ),
          { width: 58, height: 30 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("NNN"), "settings row"),
      )
      // A row pads itself one column inside a body that pads one each side.
      expect(seen[0]).toEqual({ row: 55, section: 56 })

      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("NNN"))
      // The name and its detail share one line rather than wrapping.
      expect(rowLines.length).toBe(1)
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )
})
