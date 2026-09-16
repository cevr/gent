/** @jsxImportSource @opentui/solid */
/**
 * Enter on a slash command name runs it.
 *
 * Completing `/agents` used to insert `/agents ` — a trailing space — and wait
 * for a second Enter before dispatching. Every slash command treats an empty
 * argument as "open my picker" or "show usage", so naming one is already a
 * full invocation and the first Enter dispatches it.
 *
 * The other autocomplete prefixes keep the trailing space: `@file.ts ` is the
 * start of a sentence, not a command.
 *
 * An unregistered name is the same one Enter. `/xyz` opens the popup — the
 * trigger only needs a `/` at position 0, not a matching row — and the popup
 * then holds no rows to select. The composer used to claim that Enter anyway
 * and drop it, so the first press did nothing and only a second one reported
 * `Unknown command: /xyz`. The popup declines a key it cannot act on, so the
 * draft submits and the error surfaces on the first press.
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
import { useCommand } from "../../src/command/context"
import { useExtensionUI } from "../../src/extensions/context"
import {
  SessionControllerContext,
  type SessionController,
} from "../../src/routes/session-controller"
import { SessionUiState } from "../../src/routes/session-ui-state"
import { PromptSearchState } from "../../src/components/prompt-search-state"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

interface Dispatched {
  readonly cmd: string
  readonly args: string
}

/**
 * Registers the slash commands under test: one that takes nothing (`/agents`)
 * and two that take an optional argument (`/model`, `/think`).
 */
function RegisterCommands() {
  const command = useCommand()
  onMount(() => {
    command.register([
      {
        id: "agents.view",
        title: "Agents",
        slash: "agents",
        aliases: ["tree"],
        onSelect: () => {},
      },
      {
        id: "session.model",
        title: "Set Model",
        slash: "model",
        onSelect: () => {},
        onSlash: () => {},
      },
      {
        id: "session.think",
        title: "Set Reasoning",
        slash: "think",
        onSelect: () => {},
        onSlash: () => {},
      },
    ])
  })
  return <box />
}

/** Contributes the `/` popup the composer completes against, plus `@` files. */
function Contribute() {
  const ui = useExtensionUI()
  const command = useCommand()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      items: (filter: string) =>
        command.commands().flatMap((c) =>
          Option.match(Option.fromNullishOr(c.slash), {
            onNone: () => [],
            onSome: (slash) => {
              if (!slash.includes(filter)) return []
              return [{ id: slash, label: `/${slash}` }]
            },
          }),
        ),
    },
    {
      prefix: "@",
      title: "Files",
      items: () => [{ id: "notes.ts", label: "notes.ts" }],
    },
  ])
  return <box />
}

function TestComposer(props: {
  readonly onSlashCommand: (cmd: string, args: string) => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  // The real controller derives autocomplete from the live contributions
  // (session-controller.ts:389). Without them nothing ever opens a popup and
  // Enter would reach the plain submit path, testing the wrong seam.
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
    onSubmit: () => {},
    onSlashCommand: (cmd: string, args: string) => {
      props.onSlashCommand(cmd, args)
      return Effect.void
    },
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

/** Type `text`, wait for the popup to list `expected`, then press Enter once. */
const typeThenEnter = (
  dispatched: Array<Dispatched>,
  text: string,
  expected: string,
): Effect.Effect<Awaited<ReturnType<typeof renderWithProviders>>> =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <TestComposer
            onSlashCommand={(cmd, args) => {
              dispatched.push({ cmd, args })
            }}
          >
            <Composer.Autocomplete />
          </TestComposer>
        ),
        { width: 80, height: 24 },
      ),
    )
    yield* Effect.promise(() => setup.mockInput.typeText(text))
    yield* Effect.promise(() =>
      waitForRenderedFrame(setup, (frame) => frame.includes(expected), expected),
    )
    setup.mockInput.pressEnter()
    yield* Effect.promise(() => setup.renderOnce())
    return setup
  })

describe("Composer slash Enter", () => {
  it.live("runs a zero-argument command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* typeThenEnter(dispatched, "/agents", "/agents")
      expect(dispatched).toEqual([{ cmd: "agents", args: "" }])
      // No trailing-space leftover parked in the composer.
      expect(renderFrame(setup)).not.toContain("/agents ")
    }),
  )

  it.live("opens a bare optional-argument command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      yield* typeThenEnter(dispatched, "/model", "/model")
      expect(dispatched).toEqual([{ cmd: "model", args: "" }])
    }),
  )

  it.live("opens bare /think on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      yield* typeThenEnter(dispatched, "/think", "/think")
      expect(dispatched).toEqual([{ cmd: "think", args: "" }])
    }),
  )

  it.live("passes a typed argument through on submit", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer
              onSlashCommand={(cmd, args) => {
                dispatched.push({ cmd, args })
              }}
            >
              <Composer.Autocomplete />
            </TestComposer>
          ),
          { width: 80, height: 24 },
        ),
      )
      // The space closes the slash popup, so Enter submits the whole line.
      yield* Effect.promise(() => setup.mockInput.typeText("/model sonnet"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(dispatched).toEqual([{ cmd: "model", args: "sonnet" }])
    }),
  )

  it.live("keeps the trailing space for a file reference", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer
              onSlashCommand={(cmd, args) => {
                dispatched.push({ cmd, args })
              }}
            >
              <Composer.Autocomplete />
            </TestComposer>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("@notes"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("notes.ts"), "file row"),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("@notes.ts"), "inserted"),
      )
      // The `@` path inserts and waits — it never dispatches a command.
      expect(dispatched).toEqual([])
      expect(renderFrame(setup)).toContain("@notes.ts")
    }),
  )

  it.live("reports an unregistered command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // `/xyz` matches no registered command, so the popup opens with no rows.
      // The Enter has to reach the submit path regardless: dispatching is what
      // produces `Unknown command: /xyz` from `executeSlashCommand`.
      const setup = yield* typeThenEnter(dispatched, "/xyz", "No matches")
      expect(dispatched).toEqual([{ cmd: "xyz", args: "" }])
      // The draft is gone — the key was consumed by the submit, not dropped.
      expect(renderFrame(setup)).not.toContain("/xyz")
    }),
  )

  it.live("selects a row instead of submitting while the popup has one", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // `/mod` matches `/model`, so a row exists. Enter must select that row,
      // which dispatches `/model` — not submit the literal text `/mod`.
      yield* typeThenEnter(dispatched, "/mod", "/model")
      expect(dispatched).toEqual([{ cmd: "model", args: "" }])
    }),
  )
})
