/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  dateFromMillis,
  Message,
  MessageId,
  Model,
  ModelId,
  ProviderId,
  SessionId,
  type Branch,
} from "@gent/core/protocol"
import {
  BranchPicker,
  DEFAULT_ROW_ID,
  MessagePicker,
  modelRows,
  type PromptSearchEvent,
  promptSearchItems,
  PromptSearchPalette,
  PromptSearchState,
  reasoningRows,
  SettingsPicker,
} from "../src/pickers"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"

// ── pickers ─────────────────────────────────────────────────────────────────

/**
 * The session's own docked pickers: fork-from-message, resume-branch,
 * settings and prompt search, each drawn in `PickerFrame`. Escape is the
 * interesting key: the message picker closes itself, while the branch picker
 * leaves the route, so it has to claim escape before the list treats it as a
 * dismissal.
 */

const sessionId = SessionId.make("session-test")
const branchId = BranchId.make("branch-test")

const message = (id: string, role: "user" | "assistant", text: string): Message =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(0),
  })

const branch = (id: string, name: string): Branch => ({
  id: BranchId.make(id),
  sessionId: SessionId.make("session-test"),
  name,
  createdAt: dateFromMillis(0),
})

describe("Message picker", () => {
  it.live("moves the cursor down the transcript and forks from the chosen message", () =>
    Effect.gen(function* () {
      const forked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessagePicker
            open={true}
            messages={[
              message("m1", "user", "first ask"),
              message("m2", "assistant", "first reply"),
              message("m3", "user", "second ask"),
            ]}
            onSelect={(id) => forked.push(id)}
            onClose={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("U: first ask"), "open")
      expect(renderFrame(setup)).toContain("A: first reply")

      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(forked).toEqual(["m3"])
    }),
  )

  it.live("closes on escape", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessagePicker
            open={open()}
            messages={[message("m1", "user", "only ask")]}
            onSelect={() => {}}
            onClose={() => setOpen(false)}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("only ask"), "open")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => !open(), "closed")
      expect(renderFrame(setup)).not.toContain("Fork from message")
    }),
  )
})

describe("Branch picker", () => {
  it.live("lists branches with their message counts and resumes the chosen one", () =>
    Effect.gen(function* () {
      const main = branch("branch-main", "main")
      const side = branch("branch-side", "side-quest")
      const switched: Array<string> = []

      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <BranchPicker
              open={true}
              sessionId={SessionId.make("session-test")}
              sessionName="Test Session"
              branches={[main, side]}
              onSelect={() => {
                switched.push("select")
              }}
              onClose={() => {}}
            />
          ),
          {
            client: createMockClient({
              branch: {
                getTree: () =>
                  Effect.succeed([
                    { branch: main, messageCount: 4, children: [] },
                    { branch: side, messageCount: 2, children: [] },
                  ]),
                switch: () => {
                  switched.push("switch")
                  return Effect.succeed(Option.getOrUndefined(Option.none()))
                },
              },
            }),
          },
        ),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("main (4)"), "counts")
      expect(renderFrame(setup)).toContain("side-quest (2)")
      expect(renderFrame(setup)).toContain("Resume: Test Session")
    }),
  )

  it.live("two unnamed branches started in the same minute get different labels", () =>
    Effect.gen(function* () {
      // Branch ids are UUIDv7: the head is the start time, the tail is random.
      const unnamed = (id: string): Branch => ({
        id: BranchId.make(id),
        sessionId: SessionId.make("session-test"),
        createdAt: dateFromMillis(0),
      })
      const first = unnamed("0199a1b2-c3d4-7e5f-8a6b-111111111111")
      const fork = unnamed("0199a1b2-c3d5-7e5f-8a6b-222222222222")
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <BranchPicker
              open={true}
              sessionId={SessionId.make("session-test")}
              sessionName="Test Session"
              branches={[first, fork]}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          {
            client: createMockClient({
              branch: {
                getTree: () =>
                  Effect.succeed([
                    { branch: first, messageCount: 4, children: [] },
                    { branch: fork, messageCount: 2, children: [] },
                  ]),
              },
            }),
          },
        ),
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("(4)"), "counts")
      expect(frame).toContain("11111111 (4)")
      expect(frame).toContain("22222222 (2)")
    }),
  )

  it.live("hands escape to the pane owner rather than dismissing the list itself", () =>
    Effect.gen(function* () {
      // The select list treats escape as its own dismissal. The pane's handler
      // has to win, or escape does nothing at all and the picker cannot be left.
      let closes = 0
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <BranchPicker
            open={true}
            sessionId={SessionId.make("session-test")}
            sessionName="Test Session"
            branches={[branch("branch-main", "main")]}
            onSelect={() => {}}
            onClose={() => {
              closes += 1
            }}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("main"), "open")
      setup.mockInput.pressEscape()
      // The mock terminal holds an escape until the next frame.
      yield* waitForFrame(setup, () => closes > 0, "closed")
      expect(closes).toBe(1)
    }),
  )

  it.live("resumes the branch the reader selects", () =>
    Effect.gen(function* () {
      const main = branch("branch-main", "main")
      const side = branch("branch-side", "side-quest")
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <BranchPicker
            open={true}
            sessionId={SessionId.make("session-test")}
            sessionName="Test Session"
            branches={[main, side]}
            onSelect={(branchId) => {
              selected.push(branchId)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("side-quest"), "open")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => selected.length > 0, "select")
      expect(selected).toEqual(["branch-side"])
    }),
  )
})

// ── settings picker ─────────────────────────────────────────────────────────

/**
 * The docked settings pane behind `/model` and `/think`.
 *
 * It lists rows, marks the one the next turn would use, narrows as the user
 * types, and hands the selected id back.
 */

const model = (id: string, name: string): Model =>
  new Model({ id: ModelId.make(id), name, provider: ProviderId.make("test") })

const catalogue = [
  model("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic/claude-opus-5", "Claude Opus 5"),
  model("openai/gpt-5.6-luna", "GPT-5.6 Luna"),
]

describe("Settings picker", () => {
  it.live("keeps typing from snapping the cursor back to the current row", () =>
    Effect.gen(function* () {
      // The pane preselects the row the next turn would use. That anchor has to
      // let go once the reader types: re-applying it on every narrowing drags
      // the cursor off whatever they were filtering for.
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Model"
            rows={modelRows([
              model("a/one", "Alpha One"),
              model("a/two", "Alpha Two"),
              model("a/three", "Alpha Three"),
            ])}
            current={Option.some("a/three")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker")
      // Every row matches "a", so the list does not narrow; the cursor still
      // has to move to the top, the way a fresh query always does.
      setup.mockInput.pressKey("a")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("› a"), "typed")
      setup.mockInput.pressEnter()
      expect(selected).toEqual(["a/one"])
    }),
  )

  it.live("marks the current model, filters on typing, and selects with enter", () =>
    Effect.gen(function* () {
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Model"
            rows={modelRows(catalogue)}
            current={Option.some("anthropic/claude-opus-5")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker")
      expect(renderFrame(setup)).toContain("● Claude Opus 5")
      expect(renderFrame(setup)).toContain("  Claude Sonnet 5")

      setup.mockInput.pressKey("l")
      setup.mockInput.pressKey("u")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model · 1"), "filtered")
      expect(renderFrame(setup)).not.toContain("Claude Opus 5")
      setup.mockInput.pressEnter()
      expect(selected).toEqual(["openai/gpt-5.6-luna"])
    }),
  )

  it.live("lists default plus every reasoning level and marks the session override", () =>
    Effect.gen(function* () {
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Reasoning"
            rows={reasoningRows(Option.some("max"))}
            current={Option.some("high")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Reasoning · 8"), "pane")
      expect(renderFrame(setup)).toContain("agent or config default (max)")
      expect(renderFrame(setup)).toContain("● high")
      // The current row is preselected; the top row is `default`.
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressEnter()
      expect(selected).toEqual([DEFAULT_ROW_ID])
    }),
  )

  it.live("reopening after a filter shows every row again", () =>
    Effect.gen(function* () {
      // The pane holds the query and unmounts the list on close, so closing has
      // to tell the pane the query is gone. Otherwise `/model` reopens with an
      // empty input over rows the last filter is still hiding.
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={open()}
            title="Model"
            rows={modelRows(catalogue)}
            current={Option.some("anthropic/claude-opus-5")}
            onSelect={() => {}}
            onClose={() => setOpen(false)}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker")

      setup.mockInput.pressKey("l")
      setup.mockInput.pressKey("u")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model · 1"), "filtered")

      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => !renderFrame(setup).includes("Model ·"), "closed")

      setOpen(true)
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Model ·"), "reopened")
      // Every row is back, so the empty input matches the list under it.
      expect(renderFrame(setup)).toContain("Model · 3")
      expect(renderFrame(setup)).toContain("Claude Opus 5")
      expect(renderFrame(setup)).toContain("GPT-5.6 Luna")
    }),
  )
})

// ── prompt search render ────────────────────────────────────────────────────

const openPalette = (entries: readonly string[], onEvent: (event: PromptSearchEvent) => void) =>
  Effect.promise(() =>
    renderWithProviders(
      () => (
        <PromptSearchPalette
          state={PromptSearchState.open("draft")}
          entries={entries}
          onEvent={onEvent}
        />
      ),
      { width: 90, height: 28 },
    ),
  )

describe("prompt search row keys", () => {
  it.effect("a prompt typed twice keeps one key per entry across a newer write", () =>
    Effect.sync(() => {
      // History is newest first and dedupes only the newest, so a text can
      // repeat. A newer write, even of the same text, must not move an older
      // entry's key onto another row.
      const before = promptSearchItems(["A", "B", "A"])
      const olderA = before[2]?.key
      expect(new Set(before.map((item) => item.key)).size).toBe(3)
      const after = promptSearchItems(["A", "C", "A", "B", "A"])
      expect(after.findIndex((item) => item.key === olderA)).toBe(4)
      expect(after.findIndex((item) => item.key === before[0]?.key)).toBe(2)
    }),
  )
})

describe("PromptSearchPalette renderer", () => {
  it.live("renders matching prompts with selection and footer", () =>
    Effect.gen(function* () {
      const entries = [
        "fix the session queue bug",
        "fix prompt search enter behavior",
        "add tests for renderer",
      ]
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(entries, (event) => events.push(event))
      yield* waitForFrame(setup, (frame) => frame.includes("add tests"), "open")
      setup.mockInput.pressKeys(["f", "i", "x"])
      yield* waitForFrame(setup, (frame) => !frame.includes("add tests"), "narrowed")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("Prompt search · 2")
      expect(frame).toContain("› fix")
      expect(frame).toContain("fix prompt search enter behavior")
      expect(frame).toContain("type to filter · ↑↓ move · ↵ accept · esc cancel")
      // Typing and moving both report the entry under the cursor; the last
      // report is the second match in rank order.
      expect(events.at(-1)).toEqual({
        _tag: "Highlight",
        entry: Option.some("fix the session queue bug"),
      })
    }),
  )

  it.live("renders empty-state fallback when no items match", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(["first prompt", "second prompt"], (event) =>
        events.push(event),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("first prompt"), "open")
      setup.mockInput.pressKeys(["z", "z", "z"])
      yield* waitForFrame(setup, (frame) => frame.includes("No prompt matches"), "empty")
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.none() })
    }),
  )

  it.live("keeps the draft until the reader moves, then wraps at both ends", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(["alpha", "beta", "gamma"], (event) => events.push(event))
      yield* waitForFrame(setup, (frame) => frame.includes("gamma"), "open")
      // The list sits on alpha, but nothing is reported until the reader acts.
      expect(events).toEqual([])

      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.some("gamma") })

      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.some("alpha") })

      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Accept" })
    }),
  )

  it.live("enter on an empty list still accepts, and escape cancels", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette([], (event) => events.push(event))
      yield* waitForFrame(setup, (frame) => frame.includes("No prompt matches"), "open")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Accept" })
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => events.at(-1)?._tag === "Cancel", "cancelled")
    }),
  )
})

describe("prompt search and the fork picker on a short terminal", () => {
  // Docked panes give way in whole rows: the key hint and the title go
  // before the rows the reader opened the pane for.
  for (const height of [12, 9, 8, 7, 6]) {
    it.live(`prompt search keeps its top entry at ${height} rows`, () =>
      Effect.gen(function* () {
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <PromptSearchPalette
                state={PromptSearchState.open("draft")}
                entries={["ENTRY-ONE", "ENTRY-TWO", "ENTRY-THREE"]}
                onEvent={() => {}}
              />
            ),
            { width: 60, height },
          ),
        )
        yield* waitForFrame(setup, (frame) => frame.includes("ENTRY-ONE"), "top entry")
      }).pipe(Effect.timeout("5 seconds")),
    )

    it.live(`the fork picker keeps its top message at ${height} rows`, () =>
      Effect.gen(function* () {
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <MessagePicker
                open={true}
                messages={[
                  message("m1", "user", "FIRST-ASK"),
                  message("m2", "assistant", "FIRST-REPLY"),
                  message("m3", "user", "SECOND-ASK"),
                ]}
                onSelect={() => {}}
                onClose={() => {}}
              />
            ),
            { width: 60, height },
          ),
        )
        yield* waitForFrame(setup, (frame) => frame.includes("FIRST-ASK"), "top message")
      }).pipe(Effect.timeout("5 seconds")),
    )
  }
})
