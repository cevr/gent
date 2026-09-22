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
  sessionQuery,
  type ActiveExtensionSession,
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

interface ForkPaneController {
  /** The fork this branch opened last, as the server reports it. */
  readonly fork: () => Option.Option<ForkViewType>
  /** A question on its way to the fork. */
  readonly pending: () => Option.Option<string>
  readonly error: () => Option.Option<string>
  /** Forks now when the branch has no open fork; otherwise asks the open fork. */
  readonly ask: (question: string) => void
  /** Read the fork's view again. */
  readonly refresh: () => void
}

interface ForkPaneActions {
  readonly fork: (
    question: string,
    session: ActiveExtensionSession,
  ) => Effect.Effect<void, { readonly message: string }>
  readonly ask: (
    question: string,
    session: ActiveExtensionSession,
  ) => Effect.Effect<void, { readonly message: string }>
  readonly progress: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<Option.Option<ForkViewType>, { readonly message: string }>
}

interface Outgoing {
  readonly question: string
  readonly send: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<void, { readonly message: string }>
}

/**
 * The fork's view is a session query: it follows the shell, so a reply for a
 * session the shell left never becomes the fork of the one it is on. A
 * question rides the next read, which sends it and then reads the fork.
 */
export const makeForkPane = (
  actions: ForkPaneActions,
): Effect.Effect<ForkPaneController, never, ClientTransport | ClientShell | ClientLifecycle> =>
  Effect.gen(function* () {
    let outgoing = Option.none<Outgoing>()
    const [asked, setAsked] = createSignal(Option.none<string>())
    const view = yield* sessionQuery({
      initial: Option.none<ForkViewType>(),
      follow: true,
      fetch: (session) => {
        const sending = outgoing
        outgoing = Option.none()
        setAsked(Option.map(sending, (entry) => entry.question))
        const send = Option.match(sending, {
          onNone: () => Effect.void,
          onSome: (entry) => entry.send(session),
        })
        return send.pipe(Effect.andThen(actions.progress(session)))
      },
    })
    // Sent: once the read lands, the fork's view carries the question.
    const pending = () => Option.filter(asked(), () => view.loading())
    const ask = (raw: string): void => {
      const question = raw.trim()
      const fork = view.value()
      const replying = Option.exists(fork, (current) => current.replying)
      if (Option.isSome(pending()) || replying) return
      if (question.length === 0 && Option.isSome(fork)) return
      const send = Option.match(fork, {
        onNone: () => actions.fork,
        onSome: () => actions.ask,
      })
      outgoing = Option.some({ question, send: (session) => send(question, session) })
      view.refresh()
    }
    return { fork: view.value, pending, error: view.error, ask, refresh: view.refresh }
  })

export function ForkPane(
  props: OverlayProps & { controller: ForkPaneController; onOpen: () => void },
) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal("")
  const fork = () => Option.getOrUndefined(props.controller.fork())
  const replying = () => Option.exists(props.controller.fork(), (view) => view.replying)
  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        props.onClose()
        return true
      }
      if (event.ctrl === true && event.name === "o" && Option.isSome(props.controller.fork())) {
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
    Option.match(props.controller.fork(), {
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
          <Show when={Option.getOrUndefined(props.controller.pending())}>
            {(question) => (
              <box flexDirection="column" marginBottom={1}>
                <text>
                  <span style={{ fg: theme.primary, bold: true }}>{question()}</span>
                </text>
                <text style={{ fg: theme.textMuted }}>forking…</text>
              </box>
            )}
          </Show>
          <Show when={Option.getOrUndefined(props.controller.error())}>
            {(message) => <text style={{ fg: theme.error }}>{message()}</text>}
          </Show>
        </ChromePanel.Body>
        <ChromePanel.Section>
          <box flexDirection="row">
            <text style={{ fg: theme.textMuted }}>ask: </text>
            <box flexGrow={1}>
              <input
                focused={props.open && Option.isNone(props.controller.pending()) && !replying()}
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
    const controller = yield* makeForkPane({
      fork: (question, session) =>
        asMessage(transport.request(ref(BtwRpc.Fork), { question }, session)).pipe(Effect.asVoid),
      ask: (question, session) =>
        asMessage(transport.request(ref(BtwRpc.Ask), { question }, session)).pipe(Effect.asVoid),
      progress: (session) =>
        asMessage(
          transport
            .request(ref(BtwRpc.Progress), {}, session)
            .pipe(Effect.map((result) => Option.fromUndefinedOr(result.fork))),
        ),
    })
    const [open, setOpen] = createSignal(false)
    // Each pulse from the btw extension means the fork's view changed; read it again.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId !== BTW_EXTENSION_ID) return
        if (!open()) return
        controller.refresh()
      }),
    )
    const show = () => {
      setOpen(true)
      shell.openOverlay(BTW_OVERLAY_ID)
      controller.refresh()
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
              Option.map(controller.fork(), (fork) => {
                setOpen(false)
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
