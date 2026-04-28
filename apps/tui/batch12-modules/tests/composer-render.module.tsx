/* eslint-disable */
/** @jsxImportSource @opentui/solid */
import { describe, it, test, expect } from "effect-bun-test"
import { createSignal, type JSX } from "solid-js"
import { Composer } from "../../src/components/composer"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../../src/components/composer-interaction-state"
import { ComposerState } from "../../src/components/composer-state"
import {
  SessionControllerContext,
  type SessionController,
} from "../../src/routes/session-controller"
import { SessionUiState } from "../../src/routes/session-ui-state"
import { Effect } from "effect"
import { renderFrame, renderWithProviders } from "../../src/../tests/render-harness"
function TestComposer(props: {
  readonly suspended?: boolean
  readonly onSubmit: (content: string, mode?: "queue" | "interject") => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const mockController = {
    interactionState,
    composerState: () => ComposerState.idle(),
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) => transitionComposerInteraction(current, event)),
    onSubmit: props.onSubmit,
    onSlashCommand: (_cmd: string, _args: string) => Effect.void,
    clearMessages: () => {},
    promptSearchOpen: () => props.suspended ?? false,
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    uiState: () => SessionUiState.initial(),
  } as unknown as SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}
describe("Composer renderer", () => {
  it.live("plain enter submits and clears the composer", () =>
    Effect.gen(function* () {
      const submitted: Array<{
        content: string
        mode?: "queue" | "interject"
      }> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={(content, mode) => {
              submitted.push({ content, mode })
            }}
          />
        )),
      )
      setup.mockInput.pressKeys(["h", "i"])
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("❯ hi")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([{ content: "hi", mode: "queue" }])
      expect(renderFrame(setup)).not.toContain("❯ hi")
    }),
  )
  it.live("suspended composer blocks enter submission", () =>
    Effect.gen(function* () {
      const submitted: string[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            suspended
            onSubmit={(content) => {
              submitted.push(content)
            }}
          />
        )),
      )
      setup.mockInput.pressKeys(["h", "i"])
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([])
      expect(renderFrame(setup)).toContain("❯ hi")
    }),
  )
  it.live("slash trigger renders the command popup", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={() => {}}>
              <Composer.Autocomplete />
            </TestComposer>
          ),
          { width: 80, height: 24 },
        ),
      )
      setup.mockInput.pressKeys(["/"])
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("/")
      setup.renderer.destroy()
    }),
  )
})
