/** @jsxImportSource @opentui/solid */
/**
 * The ghost line: the completion Tab would take, drawn muted under the input.
 *
 * It lives on a row of its own rather than inside the buffer. The buffer's
 * own virtual-text facility cannot draw it — marks created with `virtual: true`
 * are stored but never rendered, and holding one across an edit breaks undo —
 * and a ghost drawn beside a shrink-to-fit textarea is split mid-word by the
 * first wrap. A separate row survives wrapping and, more importantly, keeps
 * the draft exactly what the reader typed: the ghost is never in the buffer,
 * so no submit path can carry it.
 *
 * What the ghost shows is the top-ranked row, which is the row Tab completes.
 * The two cannot disagree, because both read the same ranked list.
 */
import { describe, expect, it } from "effect-bun-test"
import { createSignal, onMount, type JSX } from "solid-js"
import { Effect, Option } from "effect"
import { Composer } from "../../src/components/composer"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../../src/components/composer-interaction-state"
import { ComposerState } from "../../src/components/composer-state"
import { useCommand } from "../../src/commands"
import { useExtensionUI } from "../../src/extensions/context"
import {
  SessionControllerContext,
  type SessionController,
} from "../../src/routes/session-controller"
import { SessionUiState } from "../../src/routes/session-ui-state"
import { PromptSearchState } from "../../src/pickers"
import { rankAutocompleteItems } from "../../src/autocomplete"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

/** The commands that reproduce the `/ag` ordering problem in the live registry. */
function RegisterCommands() {
  const command = useCommand()
  onMount(() => {
    command.register([
      { id: "message.fork", title: "Fork from Message", slash: "fork", onSelect: () => {} },
      { id: "auth.manage", title: "Manage API Keys", slash: "auth", onSelect: () => {} },
      { id: "agents.view", title: "Agents", slash: "agents", onSelect: () => {} },
      { id: "session.model", title: "Set Model", slash: "model", onSelect: () => {} },
    ])
  })
  return <box />
}

/** The `/` contribution, ranked exactly as the session registry ranks it. */
function Contribute() {
  const ui = useExtensionUI()
  const command = useCommand()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      items: (filter: string) =>
        rankAutocompleteItems(
          command.commands().flatMap((c) =>
            Option.match(Option.fromNullishOr(c.slash), {
              onNone: () => [],
              onSome: (slash) => [{ id: slash, label: `/${slash}`, description: c.title }],
            }),
          ),
          filter,
        ),
    },
  ])
  return <box />
}

function TestComposer(props: {
  readonly onSubmit: (text: string) => void
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
      isOpen: () => false,
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle", turn: 0 }),
    phaseLabel: () => "idle",
    elapsed: () => 0,
    getChildren: () => [],
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: (text: string) => props.onSubmit(text),
    onSlashCommand: () => Effect.void,
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
      <RegisterCommands />
      <Contribute />
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}

const mount = (submitted: Array<string>) =>
  Effect.promise(() =>
    renderWithProviders(
      () => (
        <TestComposer
          onSubmit={(text) => {
            submitted.push(text)
          }}
        >
          <Composer.Autocomplete />
        </TestComposer>
      ),
      { width: 80, height: 24 },
    ),
  )

describe("Composer ghost line", () => {
  it.live("offers the top-ranked completion for a partial name", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/ag"))
      // `agents` is the ghost because it is the top row. Before ranking, the
      // top row was `/fork` — a ghost then would have offered the wrong word.
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("agents ⇥"), "ghost"),
      )
    }),
  )

  it.live("withdraws the ghost when the filter matches nothing", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/ag"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("agents ⇥"), "ghost"),
      )
      // `/agzz` matches no command, so there is nothing to offer.
      yield* Effect.promise(() => setup.mockInput.typeText("zz"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("agents ⇥"), "ghost withdrawn"),
      )
    }),
  )

  it.live("shows no ghost once the name is fully typed", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/agents"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("/agents"), "draft"),
      )
      // There is no remainder left to offer, so the row stays empty.
      expect(renderFrame(setup)).not.toContain("agents ⇥")
    }),
  )

  it.live("never submits the ghost as text", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      // `@` has no dispatch path, so Enter here submits the draft verbatim —
      // the cleanest place to prove the ghost is not part of it.
      yield* Effect.promise(() => setup.mockInput.typeText("hello wor"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual(["hello wor"])
    }),
  )
})
