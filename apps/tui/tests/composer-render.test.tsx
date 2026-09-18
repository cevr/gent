/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { createSignal, type JSX } from "solid-js"
import { Effect } from "effect"
import { Composer } from "../src/components/composer"
import {
  ComposerInteractionState,
  ComposerState,
  type SessionController,
  SessionControllerContext,
  SessionUiState,
  transitionComposerInteraction,
} from "../src/session"
import { PromptSearchState } from "../src/pickers"
import { useExtensionUI } from "../src/extensions/host"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"

/**
 * Registers the `/` contribution the popup draws from. Without a contribution
 * `deriveAutocomplete` finds no prefixes and returns none, so no popup can
 * open and a test asserting on one would be asserting on the echoed draft.
 */
function Contribute() {
  const ui = useExtensionUI()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      items: () => [
        { id: "clear", label: "/clear", description: "Clear messages" },
        { id: "sessions", label: "/sessions", description: "Open sessions picker" },
      ],
    },
  ])
  return <box />
}
function TestComposer(props: {
  readonly suspended?: boolean
  readonly onSubmit: (content: string, mode?: "queue" | "interject") => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const ext = useExtensionUI()
  const mockController = {
    items: () => [],
    messages: () => [],
    forkMessages: () => [],
    queueState: () => ({ steering: [], followUp: [] }),
    interactionState,
    saveDraft: () => {},
    uiState: SessionUiState.initial,
    composerState: () => ComposerState.idle(),
    promptSearch: {
      state: PromptSearchState.closed,
      entries: () => [],
      isOpen: () => props.suspended === true,
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle", turn: 0 }),
    phaseLabel: () => "idle",
    elapsed: () => 0,
    getChildren: () => [],
    // Production threads the live contributions here (session-controller.ts).
    // Dropping them makes every popup assertion vacuous, so the harness
    // matches the real call.
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: props.onSubmit,
    onSlashCommand: (_cmd: string, _args: string) => Effect.void,
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerDismiss: () => {},
    onBranchPickerSelect: () => {},
  } satisfies SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <Contribute />
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
      expect(renderFrame(setup)).toContain("┃ hi")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([{ content: "hi", mode: "queue" }])
      expect(renderFrame(setup)).not.toContain("┃ hi")
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
      expect(renderFrame(setup)).toContain("┃ hi")
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
      yield* Effect.promise(() => setup.mockInput.typeText("/"))
      // The rows arrive through a resource, so the frame is polled rather than
      // rendered once.
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("/sessions"), "command rows"),
      )
      const frame = renderFrame(setup)
      // Assert the popup itself: its title, both contributed rows, and the
      // footer it draws. A bare `toContain("/")` passes on the slash echoed in
      // the composer, so it holds even with no popup mounted at all.
      expect(frame).toContain("Commands")
      expect(frame).toContain("/clear")
      expect(frame).toContain("Clear messages")
      expect(frame).toContain("/sessions")
      // The footer names both keys because they do different things: enter
      // runs the command it completes, tab only completes it.
      expect(frame).toContain("Enter Run")
      expect(frame).toContain("Tab Complete")
      setup.renderer.destroy()
    }),
  )
})
