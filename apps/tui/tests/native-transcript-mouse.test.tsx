/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import { NativeTranscript } from "../src/components/native-transcript"
import { renderWithProviders } from "./render-harness-boundary"

describe("native transcript mouse tracking", () => {
  it.live("native history leaves the wheel to the terminal; the expanded view takes it back", () =>
    Effect.gen(function* () {
      const [expanded, setExpanded] = createSignal(false)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <NativeTranscript
            items={[]}
            streaming={false}
            footerHeight={3}
            expanded={expanded()}
            toolsExpanded={false}
            displayRevision={0}
            overlayOpen={false}
            renderItems={() => <box />}
          >
            <box />
          </NativeTranscript>
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(setup.renderer.useMouse).toBe(false)
      setExpanded(true)
      yield* Effect.promise(() => setup.renderOnce())
      expect(setup.renderer.useMouse).toBe(true)
      setExpanded(false)
      yield* Effect.promise(() => setup.renderOnce())
      expect(setup.renderer.useMouse).toBe(false)
    }),
  )
})
