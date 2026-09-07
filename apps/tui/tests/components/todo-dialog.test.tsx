/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import { TodoId, type TodoEntry } from "@gent/extensions/client.js"
import { TodoDialog } from "../../src/components/todo-dialog"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

describe("Todo dialog navigation", () => {
  it.live("opens a selected task and returns to the list before closing", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TodoDialog
              open={open()}
              onClose={() => setOpen(false)}
              todos={[
                { id: TodoId.make("todo-first"), subject: "Read the source", status: "pending" },
                ...Array.from({ length: 10 }, (_, index): TodoEntry => ({
                  id: TodoId.make(`todo-middle-${index}`),
                  subject: `Inspect section ${index}`,
                  status: "pending",
                })),
                {
                  id: TodoId.make("todo-second"),
                  subject: "Check the result",
                  status: "completed",
                },
              ]}
            />
          ),
          { width: 44, height: 12 },
        ),
      )
      expect(renderFrame(setup)).toContain("Read the source")
      for (let index = 0; index < 11; index++) setup.mockInput.pressArrow("down")
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Check the result"),
          "last todo selected",
        ),
      )
      setup.mockInput.pressEnter()
      const detail = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Subject:"), "todo detail"),
      )
      expect(detail).toContain("Check the result")
      expect(detail).toContain("completed")
      expect(detail).not.toContain("Read the source")
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Check the result") && !frame.includes("Subject:"),
          "selected todo restored",
        ),
      )
      expect(open()).toBe(true)
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "todos closed"))
      expect(open()).toBe(false)
    }),
  )
})
