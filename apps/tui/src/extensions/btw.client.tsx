/** @jsxImportSource @opentui/solid */
import { Effect, Option } from "effect"
import { createSignal, For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import { BTW_EXTENSION_ID, BtwRpc, type ForkViewType } from "@gent/extensions/client.js"
import {
  clientCommandContribution,
  clientContributions,
  ClientLifecycle,
  ClientShell,
  ClientTransport,
  defineClientExtension,
  overlayContribution,
  type OverlayProps,
} from "./client-facets.js"
import { ChromePanel } from "../ui"
import { useTheme } from "../theme"
import { useScopedKeyboard, useTerminalDimensions } from "../terminal"

// ── builtins/btw.client ─────────────────────────────────────────────────────

/**
 * `/btw` fork pane.
 *
 * `/btw <question>` (alias `/side`) forks the branch into a parallel child
 * session seeded with its context and opens a pane over it; `/btw` alone
 * reopens the pane on the fork this branch opened last, or forks without
 * asking. Follow-ups type into the pane's input. `^o` opens the fork as the
 * shell's session; `esc` closes the pane and leaves the fork where it is.
 */

const BTW_OVERLAY_ID = "btw"

interface ForkPaneState {
  readonly fork: Option.Option<ForkViewType>
  /** A question on its way to the fork. */
  readonly pending: Option.Option<string>
  readonly error: Option.Option<string>
}

const emptyPane: ForkPaneState = {
  fork: Option.none(),
  pending: Option.none(),
  error: Option.none(),
}

interface ForkPaneController {
  readonly state: () => ForkPaneState
  /** Forks now when the branch has no open fork; otherwise asks the open fork. */
  readonly ask: (question: string) => void
  /** Applies the server's view of the fork. */
  readonly sync: (fork: Option.Option<ForkViewType>) => void
  readonly reset: () => void
}

interface ForkPaneActions {
  readonly fork: (question: string) => Effect.Effect<void, { readonly message: string }, never>
  readonly ask: (question: string) => Effect.Effect<void, { readonly message: string }, never>
  readonly progress: Effect.Effect<Option.Option<ForkViewType>, { readonly message: string }, never>
}

/** Pane state plus the ask action; shared by the slash command and the overlay. */
export const makeForkPane = (
  actions: ForkPaneActions,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
): ForkPaneController => {
  const [state, setState] = createSignal<ForkPaneState>(emptyPane)
  // Each reset starts a new generation; a reply from an earlier one is discarded.
  let generation = 0
  const settle = (asked: number, change: (current: ForkPaneState) => ForkPaneState) =>
    Effect.sync(() => {
      if (asked !== generation) return
      setState(change)
    })
  const failed = (asked: number, message: string) =>
    settle(asked, (current) => ({
      ...current,
      pending: Option.none(),
      error: Option.some(message),
    }))
  return {
    state,
    reset: () => {
      generation += 1
      setState(emptyPane)
    },
    sync: (fork) => {
      setState((current) => ({ ...current, fork }))
    },
    ask: (raw) => {
      const question = raw.trim()
      const asked = generation
      const current = state()
      const replying = Option.match(current.fork, {
        onNone: () => false,
        onSome: (view) => view.replying,
      })
      if (Option.isSome(current.pending) || replying) return
      if (question.length === 0 && Option.isSome(current.fork)) return
      setState((previous) => ({
        ...previous,
        pending: Option.some(question),
        error: Option.none(),
      }))
      const send = Option.match(current.fork, {
        onNone: () => actions.fork(question),
        onSome: () => actions.ask(question),
      })
      cast(
        send.pipe(
          Effect.andThen(actions.progress),
          // Sent: the fork's view carries the question from here on.
          Effect.flatMap((fork) =>
            settle(asked, (previous) => ({ ...previous, fork, pending: Option.none() })),
          ),
          Effect.catch((error) => failed(asked, error.message)),
        ),
      )
    },
  }
}

export function ForkPane(
  props: OverlayProps & { controller: ForkPaneController; onOpen: () => void },
) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal("")
  const state = () => props.controller.state()
  const fork = () => Option.getOrUndefined(state().fork)
  const replying = () =>
    Option.match(state().fork, { onNone: () => false, onSome: (view) => view.replying })
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
      if (event.ctrl === true && event.name === "o" && Option.isSome(state().fork)) {
        props.onOpen()
        return true
      }
    },
    // Not `capture`: a capturing scope stops every key, and the pane's input
    // would never see the follow-up being typed.
    { when: () => props.open },
  )
  const submit = () => {
    const question = draft()
    setDraft("")
    props.controller.ask(question)
  }

  const width = () => Math.min(dimensions().width - 4, 100)
  const height = () => Math.max(8, dimensions().height - 4)
  const left = () => Math.max(0, Math.floor((dimensions().width - width()) / 2))
  const title = () =>
    Option.match(state().fork, {
      onNone: () => "btw · fork",
      onSome: (view) => `btw · ${view.name}`,
    })

  return (
    <Show when={props.open}>
      <ChromePanel.Root title={title()} width={width()} height={height()} left={left()} top={2}>
        <ChromePanel.Body>
          <Show when={fork()}>
            {(view) => (
              <For each={view().turns}>
                {(turn) => (
                  <box flexDirection="column" marginBottom={1}>
                    <text>
                      <span style={{ fg: theme.primary, bold: true }}>{turn.question}</span>
                    </text>
                    <Show
                      when={turn.answer.length > 0}
                      fallback={<text style={{ fg: theme.textMuted }}>thinking…</text>}
                    >
                      <text style={{ fg: theme.text }}>{turn.answer}</text>
                    </Show>
                  </box>
                )}
              </For>
            )}
          </Show>
          <Show when={Option.getOrUndefined(state().pending)}>
            {(question) => (
              <box flexDirection="column" marginBottom={1}>
                <text>
                  <span style={{ fg: theme.primary, bold: true }}>{question()}</span>
                </text>
                <text style={{ fg: theme.textMuted }}>forking…</text>
              </box>
            )}
          </Show>
          <Show when={Option.getOrUndefined(state().error)}>
            {(message) => <text style={{ fg: theme.error }}>{message()}</text>}
          </Show>
        </ChromePanel.Body>
        <ChromePanel.Section>
          <box flexDirection="row">
            <text style={{ fg: theme.textMuted }}>ask: </text>
            <box flexGrow={1}>
              <input
                focused={props.open && Option.isNone(state().pending) && !replying()}
                value={draft()}
                onInput={setDraft}
                onSubmit={submit}
                backgroundColor="transparent"
                focusedBackgroundColor="transparent"
              />
            </box>
          </box>
        </ChromePanel.Section>
        <ChromePanel.Footer>
          a parallel session from here · enter ask · ^o open · esc close
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}

export default defineClientExtension(BTW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle
    const asMessage = <A, E>(effect: Effect.Effect<A, E, never>) =>
      effect.pipe(Effect.mapError((error) => ({ message: String(error) })))
    const progress = asMessage(
      transport
        .request(ref(BtwRpc.Progress), {})
        .pipe(Effect.map((result) => Option.fromUndefinedOr(result.fork))),
    )
    const controller = makeForkPane(
      {
        fork: (question) =>
          asMessage(transport.request(ref(BtwRpc.Fork), { question })).pipe(Effect.asVoid),
        ask: (question) =>
          asMessage(transport.request(ref(BtwRpc.Ask), { question })).pipe(Effect.asVoid),
        progress,
      },
      shell.cast,
    )
    const [open, setOpen] = createSignal(false)
    const refresh = () => shell.cast(progress.pipe(Effect.map(controller.sync), Effect.ignore))
    // Each pulse from the btw extension means the fork's view changed; read it and apply it.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId !== BTW_EXTENSION_ID) return
        if (!open()) return
        refresh()
      }),
    )
    const show = () => {
      setOpen(true)
      shell.openOverlay(BTW_OVERLAY_ID)
      refresh()
    }
    return clientContributions(
      clientCommandContribution({
        id: "btw",
        title: "Fork here",
        description: "A parallel session with everything up to now; ask it on the side",
        category: "Session",
        slash: "btw",
        aliases: ["side"],
        onSelect: show,
        onSlash: (args) => {
          show()
          if (args.trim().length > 0) controller.ask(args)
        },
      }),
      overlayContribution({
        id: BTW_OVERLAY_ID,
        component: (props) => (
          <ForkPane
            {...props}
            onClose={() => {
              setOpen(false)
              props.onClose()
            }}
            controller={controller}
            onOpen={() => {
              Option.map(controller.state().fork, (fork) => {
                setOpen(false)
                controller.reset()
                props.onClose()
                shell.switchSession({
                  sessionId: fork.sessionId,
                  branchId: fork.branchId,
                  name: fork.name,
                })
              })
            }}
          />
        ),
      }),
    )
  }),
})
