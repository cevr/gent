/** @jsxImportSource @opentui/solid */
/**
 * `/btw` side-question pane.
 *
 * `/btw <question>` (alias `/side`) opens a full-screen pane, asks the
 * server's `BtwRpc.Ask` with the exchange so far, and streams nothing to the
 * branch. Follow-ups type into the pane's input; `esc` closes and forgets the
 * exchange. State lives in module signals owned by this client extension.
 */
import { Effect, Option } from "effect"
import { createSignal, For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import { BTW_EXTENSION_ID, BtwRpc, type SideTurnType } from "@gent/extensions/client.js"
import {
  clientContributions,
  clientCommandContribution,
  defineClientExtension,
  overlayContribution,
  type OverlayProps,
} from "../client-facets.js"
import { ClientTransport } from "../client-transport"
import { ClientShell } from "../client-services"
import { useTheme } from "../../theme/index"
import { useTerminalDimensions } from "../../terminal-dimensions"
import { useScopedKeyboard } from "../../keyboard/context"

export const BTW_OVERLAY_ID = "btw"

export interface SideQuestionPaneState {
  readonly turns: ReadonlyArray<SideTurnType>
  readonly pending: Option.Option<string>
  readonly error: Option.Option<string>
}

const emptyPane: SideQuestionPaneState = {
  turns: [],
  pending: Option.none(),
  error: Option.none(),
}

export interface SideQuestionPaneController {
  readonly state: () => SideQuestionPaneState
  readonly ask: (question: string) => void
  readonly reset: () => void
}

/** Pane state plus the ask action; shared by the slash command and the overlay. */
export const makeSideQuestionPane = (
  ask: (input: {
    question: string
    previous: ReadonlyArray<SideTurnType>
  }) => Effect.Effect<{ readonly answer: string }, { readonly message: string }, never>,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
): SideQuestionPaneController => {
  const [state, setState] = createSignal<SideQuestionPaneState>(emptyPane)
  return {
    state,
    reset: () => setState(emptyPane),
    ask: (raw) => {
      const question = raw.trim()
      if (question.length === 0 || Option.isSome(state().pending)) return
      setState((current) => ({ ...current, pending: Option.some(question), error: Option.none() }))
      cast(
        ask({ question, previous: state().turns }).pipe(
          Effect.map(({ answer }) => {
            setState((current) => ({
              turns: [...current.turns, { question, answer }],
              pending: Option.none(),
              error: Option.none(),
            }))
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              setState((current) => ({
                ...current,
                pending: Option.none(),
                error: Option.some(error.message),
              }))
            }),
          ),
        ),
      )
    },
  }
}

export function SideQuestionPane(props: OverlayProps & { controller: SideQuestionPaneController }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal("")
  const state = () => props.controller.state()
  const close = () => {
    props.controller.reset()
    props.onClose()
  }
  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        close()
        return true
      }
    },
    { when: () => props.open, capture: true },
  )
  const submit = () => {
    const question = draft()
    setDraft("")
    props.controller.ask(question)
  }

  return (
    <Show when={props.open}>
      <box
        position="absolute"
        top={0}
        left={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={theme.background}
        flexDirection="column"
      >
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text>
            <span style={{ fg: theme.primary, bold: true }}>
              btw · side question (not added to the session) · esc closes
            </span>
          </text>
        </box>
        <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1} stickyScroll={true}>
          <For each={state().turns}>
            {(turn) => (
              <box flexDirection="column" marginTop={1}>
                <text>
                  <span style={{ fg: theme.text, bold: true }}>{turn.question}</span>
                </text>
                <text style={{ fg: theme.text }}>{turn.answer}</text>
              </box>
            )}
          </For>
          <Show when={Option.getOrUndefined(state().pending)}>
            {(question) => (
              <box flexDirection="column" marginTop={1}>
                <text>
                  <span style={{ fg: theme.text, bold: true }}>{question()}</span>
                </text>
                <text style={{ fg: theme.textMuted }}>thinking…</text>
              </box>
            )}
          </Show>
          <Show when={Option.getOrUndefined(state().error)}>
            {(message) => <text style={{ fg: theme.error }}>{message()}</text>}
          </Show>
        </scrollbox>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>follow-up: </text>
          <box flexGrow={1}>
            <input
              focused={props.open && Option.isNone(state().pending)}
              value={draft()}
              onInput={setDraft}
              onSubmit={submit}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
            />
          </box>
        </box>
      </box>
    </Show>
  )
}

export default defineClientExtension(BTW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const controller = makeSideQuestionPane(
      (input) =>
        transport
          .request(ref(BtwRpc.Ask), input)
          .pipe(Effect.mapError((error) => ({ message: String(error) }))),
      shell.cast,
    )
    return clientContributions(
      clientCommandContribution({
        id: "btw",
        title: "Side question",
        description: "Ask about the conversation without adding to it",
        category: "Session",
        slash: "btw",
        aliases: ["side"],
        onSelect: () => shell.openOverlay(BTW_OVERLAY_ID),
        onSlash: (args) => {
          shell.openOverlay(BTW_OVERLAY_ID)
          controller.ask(args)
        },
      }),
      overlayContribution({
        id: BTW_OVERLAY_ID,
        component: (props) => <SideQuestionPane {...props} controller={controller} />,
      }),
    )
  }),
})
