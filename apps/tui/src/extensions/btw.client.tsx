/** @jsxImportSource @opentui/solid */
import { Effect, Option } from "effect"
import { createSignal, For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  BTW_EXTENSION_ID,
  BTW_QUESTION_TYPE,
  BtwRpc,
  forkQuestionBody,
  type ForkViewType,
} from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  ChromePanel,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  defineClientExtension,
  messageRendererContribution,
  PickerFrame,
  sessionQuery,
  UserRow,
  useScopedKeyboard,
  useTerminalDimensions,
  useTheme,
  widgetContribution,
} from "@gent/tui/extensions"

// ── btw fork pane ───────────────────────────────────────────────────────────

/**
 * `/btw` fork pane.
 *
 * `/btw <question>` (alias `/side`) forks the branch into a parallel child
 * session seeded with its context and opens a pane over it; `/btw` alone
 * reopens the pane on the fork this branch opened last, or forks without
 * asking. The pane docks under the composer; follow-ups type into its ask line. `^o` opens the fork as the
 * shell's session; `esc` closes the pane and leaves the fork where it is.
 */

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
  /** The session the question was asked in; it goes there even after a switch. */
  readonly session: ActiveExtensionSession
  readonly send: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<void, { readonly message: string }>
}

const sameSession = (left: ActiveExtensionSession, right: ActiveExtensionSession) =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

/** What the reader sees when an ask cannot go out now. */
const BUSY_NOTICE = "btw: the fork is still answering; ask again when it is done"

/**
 * The fork's view is a session query: it follows the shell, so a reply for a
 * session the shell left never becomes the fork of the one it is on. A
 * question rides the next read, which sends it to the session it was asked in
 * and then reads the fork of the session in view.
 */
export const makeForkPane = (
  actions: ForkPaneActions,
): Effect.Effect<ForkPaneController, never, ClientContext> =>
  Effect.gen(function* () {
    const { transport, shell } = yield* ClientContext
    let outgoing = Option.none<Outgoing>()
    const [asked, setAsked] = createSignal(Option.none<string>())
    const view = yield* sessionQuery({
      initial: Option.none<ForkViewType>(),
      follow: true,
      fetch: (session) => {
        const sending = outgoing
        outgoing = Option.none()
        // The pane shows a question as pending only under its own session.
        setAsked(
          Option.map(
            Option.filter(sending, (entry) => sameSession(entry.session, session)),
            (entry) => entry.question,
          ),
        )
        const send = Option.match(sending, {
          onNone: () => Effect.void,
          onSome: (entry) => {
            const notify = (failure: { readonly message: string }) =>
              Effect.sync(() =>
                shell.notify(`btw: not asked "${entry.question}": ${failure.message}`),
              )
            // A question asked in a session the reader has left fails out
            // loud, with its text, instead of vanishing. Its failure is this
            // read's error only when this read is for the session it was asked
            // in; otherwise this read goes on to read its own session's fork.
            if (!sameSession(entry.session, session)) {
              return entry.send(entry.session).pipe(Effect.catch(notify))
            }
            return entry.send(entry.session).pipe(
              Effect.tapError((failure) =>
                Effect.suspend(() => {
                  const here = Option.exists(transport.currentSession(), (now) =>
                    sameSession(now, entry.session),
                  )
                  if (here) return Effect.void
                  return notify(failure)
                }),
              ),
            )
          },
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
      // One question at a time: a second one is refused out loud, never
      // dropped and never written over the one still waiting to go.
      if (Option.isSome(outgoing) || Option.isSome(pending()) || replying) {
        if (question.length > 0) shell.notify(BUSY_NOTICE)
        return
      }
      if (question.length === 0 && Option.isSome(fork)) return
      const session = transport.currentSession()
      if (Option.isNone(session)) return
      const send = Option.match(fork, {
        onNone: () => actions.fork,
        onSome: () => actions.ask,
      })
      outgoing = Option.some({
        question,
        session: session.value,
        send: (target) => send(question, target),
      })
      view.refresh()
    }
    return { fork: view.value, pending, error: view.error, ask, refresh: view.refresh }
  })

/** Text a key types into the draft: printable, never a control sequence. */
const typedText = (sequence: Option.Option<string>): Option.Option<string> =>
  Option.filter(
    sequence,
    (text) => text.length > 0 && [...text].every((char) => char >= " " && char !== "\u007f"),
  )

/** The ask line is one line: a pasted line break becomes a space, other control bytes drop. */
const pastedText = (text: string): string =>
  [...text.replace(/\r?\n/g, " ")].filter((char) => char >= " " && char !== "\u007f").join("")

/**
 * One blank row between turns, none above the first. The gap sits above a turn,
 * not under it, so a squeezed body that holds its last row shows text.
 */
const gapAbove = (position: number): number => Math.min(position, 1)

/**
 * The fork pane, docked under the composer like the thread and agents panes.
 *
 * The composer keeps the terminal's focus, so the pane takes its keys through
 * the keyboard scope, as the agents filter does: a key it types or acts on
 * never reaches the composer, and any other key (a keybind) still does. A
 * paste goes to the ask line through the same scope.
 */
export function ForkPane(props: {
  open: boolean
  controller: ForkPaneController
  onClose: () => void
  onOpen: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal("")
  const fork = () => Option.getOrUndefined(props.controller.fork())
  const replying = () => Option.exists(props.controller.fork(), (view) => view.replying)
  const ready = () => Option.isNone(props.controller.pending()) && !replying()
  // The ask line takes the pane's keys. It sits inside the frame, so a frame
  // that draws no row takes none of them (`KeyboardGate`).
  const AskLine = () => {
    useScopedKeyboard(paneKey, {
      paste: (text) => {
        setDraft((current) => current + pastedText(text))
        return true
      },
    })
    return (
      <ChromePanel.Section>
        <text style={{ fg: theme.text }} wrapMode="none">
          <span style={{ fg: theme.textMuted }}>ask › </span>
          {draft()}
          <Show when={ready()}>
            <span style={{ fg: theme.primary }}>│</span>
          </Show>
        </text>
      </ChromePanel.Section>
    )
  }
  const paneKey = (event: Parameters<Parameters<typeof useScopedKeyboard>[0]>[0]) => {
    if (event.name === "escape") {
      props.onClose()
      return true
    }
    if (event.ctrl === true && event.name === "o") {
      if (Option.isSome(props.controller.fork())) props.onOpen()
      return true
    }
    if (event.name === "return") {
      // A question typed while the fork replies waits in the draft.
      if (!ready()) return true
      const question = draft()
      setDraft("")
      props.controller.ask(question)
      return true
    }
    if (event.name === "backspace") {
      setDraft((current) => [...current].slice(0, -1).join(""))
      return true
    }
    if (event.ctrl === true || event.meta === true) return false
    const typed = typedText(Option.fromNullishOr(event.sequence))
    if (Option.isNone(typed)) return false
    setDraft((current) => current + typed.value)
    return true
  }

  const height = () => Math.max(8, Math.floor(dimensions().height / 2))
  const title = () =>
    Option.match(props.controller.fork(), {
      onNone: () => "btw · fork",
      onSome: (view) => `btw · ${view.name}`,
    })

  return (
    <Show when={props.open}>
      <PickerFrame
        height={height()}
        title={title()}
        footer="a parallel session from here · enter ask · ^o open · esc close"
      >
        <ChromePanel.Body stickToBottom>
          <Show when={fork()}>
            {(view) => (
              <For each={view().turns}>
                {(turn, index) => (
                  <box flexDirection="column" marginTop={gapAbove(index())}>
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
              <box flexDirection="column" marginTop={gapAbove(fork()?.turns.length ?? 0)}>
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
        <AskLine />
      </PickerFrame>
    </Show>
  )
}

/** The fork pane's name in the host's one pane slot. */
const BTW_PANE = "btw.pane"

export default defineClientExtension(BTW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, shell, lifecycle } = yield* ClientContext
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
    const open = () => shell.pane.isOpen(BTW_PANE)
    // Each pulse from the btw extension means the fork's view changed; read it again.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId !== BTW_EXTENSION_ID) return
        if (!open()) return
        controller.refresh()
      }),
    )
    const show = () => {
      shell.pane.open(BTW_PANE)
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
      // The fork opened as the shell's session: the model read a header that
      // says whose history it holds; the reader sees the question they asked.
      // This renderer draws only messages of the question type. The question
      // is the reader's prompt in the fork, so the transcript pins it.
      messageRendererContribution(
        BTW_QUESTION_TYPE,
        (props) => (
          <UserRow
            {...props}
            header="btw · side question"
            content={forkQuestionBody(props.content)}
          />
        ),
        { prompt: forkQuestionBody },
      ),
      widgetContribution({
        id: BTW_PANE,
        slot: "below-input",
        component: () => (
          <ForkPane
            open={open()}
            controller={controller}
            onClose={() => shell.pane.close(BTW_PANE)}
            onOpen={() => {
              Option.map(controller.fork(), (fork) => {
                shell.pane.close(BTW_PANE)
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
