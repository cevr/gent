/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { SessionId } from "@gent/core-internal/domain/ids"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { SessionTree } from "../../src/components/session-tree"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

describe("Session tree navigation", () => {
  it.live("selects a child with the keyboard and closes with Escape", () =>
    Effect.gen(function* () {
      const rootId = SessionId.make("tree-root")
      const childId = SessionId.make("tree-child")
      let selected = Option.none<SessionId>()
      const [open, setOpen] = createSignal(true)
      const session = (id: SessionId, name: string) => ({
        id,
        name,
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SessionTree
            open={open()}
            tree={{
              session: session(rootId, "Alpha"),
              children: [{ session: session(childId, "Beta"), children: [] }],
            }}
            currentSessionId={rootId}
            onSelect={(id) => {
              selected = Option.some(id)
            }}
            onClose={() => setOpen(false)}
          />
        )),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(selected).toEqual(Option.some(childId))
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "session tree closed"))
      expect(open()).toBe(false)
      expect(renderFrame(setup)).not.toContain("Session Tree")
    }),
  )
})
