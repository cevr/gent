/** @jsxImportSource @opentui/solid */
/**
 * The two centred pickers: fork-from-message and resume-branch.
 *
 * The message picker is `SelectList` in `ChromePanel` chrome; the branch
 * picker is a docked pane and draws `PickerFrame`. Escape is the interesting
 * key: the message picker closes itself, while the branch picker leaves the
 * route, so it has to claim escape before the list treats it as a dismissal.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, Message, MessageId, SessionId, dateFromMillis } from "@gent/core/protocol"
import { BranchPicker, MessagePicker } from "../../src/pickers"
import type { Branch } from "@gent/sdk"
import { createMockClient, renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("U: first ask"), "open"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("only ask"), "open"),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "closed"))
      expect(renderFrame(setup)).not.toContain("Fork From Message")
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("main (4)"), "counts"),
      )
      expect(renderFrame(setup)).toContain("side-quest (2)")
      expect(renderFrame(setup)).toContain("Resume: Test Session")
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("main"), "open"),
      )
      setup.mockInput.pressEscape()
      // The mock terminal holds an escape until the next frame.
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => closes > 0, "closed"))
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("side-quest"), "open"),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => selected.length > 0, "select"))
      expect(selected).toEqual(["branch-side"])
    }),
  )
})
