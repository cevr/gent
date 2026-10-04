/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { createSignal, For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  BTW_EXTENSION_ID,
  BTW_MERGE_TYPE,
  BTW_QUESTION_TYPE,
  BtwRpc,
  ForkMergeDetails,
  forkMergePrompt,
  forkQuestionBody,
  type ForkViewType,
} from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  ChromePanel,
  CollapsedRow,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  defineClientExtension,
  messageRendererContribution,
  pastedLine,
  keyHint,
  KeyHints,
  lineEdit,
  PickerFrame,
  type QueuedMessage,
  repliesInView,
  sessionQuery,
  textWidth,
  truncate,
  typedKey,
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
 * asking. The pane docks under the composer; follow-ups type into its ask
 * line. Enter on an empty ask line opens the fork as the shell's session;
 * `ctrl+s` merges the fork's last reply into this branch (one message that
 * names it, for the branch's model to read) and closes the pane; `esc`
 * closes the pane and leaves the fork where it is.
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
  /** The fork answered and nothing is on its way to it: a merge can land. */
  readonly mergeable: () => boolean
  /**
   * Merges the fork's last reply into the branch in view. `done` runs once it
   * is there, and only while that branch is still in view.
   */
  readonly merge: (done: () => void) => void
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
  readonly merge: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<{ readonly merged: boolean }, { readonly message: string }>
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
                  const here = sameSession(transport.currentSession(), entry.session)
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
      const send = Option.match(fork, {
        onNone: () => actions.fork,
        onSome: () => actions.ask,
      })
      outgoing = Option.some({
        question,
        session,
        send: (target) => send(question, target),
      })
      view.refresh()
    }
    const replying = () => Option.exists(view.value(), (current) => current.replying)
    const answered = () =>
      Option.exists(view.value(), (current) => (current.turns.at(-1)?.answer.length ?? 0) > 0)
    const waiting = () => Option.isSome(outgoing) || Option.isSome(pending()) || replying()
    const mergeable = () => answered() && !waiting()
    const merges = repliesInView(transport.currentSession, sameSession)
    // The reasons the server gives too; said here, the key costs no round trip.
    const merge = (done: () => void): void => {
      if (Option.isNone(view.value())) return shell.notify("btw: no fork to merge")
      if (waiting()) return shell.notify("btw: the fork is still answering; merge when it is done")
      if (!answered()) return shell.notify("btw: the fork has no reply to merge yet")
      // A late answer for a session the reader left touches nothing in view.
      const reply = merges.take()
      shell.cast(
        actions.merge(transport.currentSession()).pipe(
          Effect.match({
            // A failure is said out loud wherever the reader is: the merge is not there.
            onFailure: (failure) => shell.notify(`btw: not merged: ${failure.message}`),
            onSuccess: ({ merged }) =>
              reply.write(() => {
                if (!merged) shell.notify("btw: this reply is already merged")
                done()
              }),
          }),
        ),
      )
    }
    return {
      fork: view.value,
      pending,
      error: view.error,
      ask,
      refresh: view.refresh,
      mergeable,
      merge,
    }
  })

// ── merge row ──

const decodeMergeDetails = Schema.decodeUnknownOption(ForkMergeDetails)

const MERGED = "↳ merged btw · "

/** `↳ merged btw · <question> → <reply>` in one line of `width` columns, cut at its end. */
const mergedLabel = (details: ForkMergeDetails, width: number): string =>
  truncate(`${MERGED}${details.question} → ${details.reply}`, width)

/** A merge waiting for the turn in the queue widget: the question it merges, not its text. */
const mergeQueueLabel = (message: QueuedMessage): string =>
  Option.match(decodeMergeDetails(message.details), {
    onNone: () => "↳ btw merge",
    onSome: (details) => `↳ btw merge · ${details.question}`,
  })

/**
 * A merge in the transcript: one collapsed row with the question and the
 * reply it merged. The model reads the ids in the message's text; the row
 * shows what the reader merged.
 */
export function ForkMergeRow(props: { readonly details: unknown }) {
  const dimensions = useTerminalDimensions()
  // The rail, its gap and the transcript's side margins.
  const width = () => Math.max(textWidth(MERGED), dimensions().width - 4)
  const label = () =>
    Option.match(decodeMergeDetails(props.details), {
      onNone: () => "↳ merged a btw fork",
      onSome: (details) => mergedLabel(details, width()),
    })
  return <CollapsedRow label={label()} />
}

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
  onMerge: () => void
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
        // The ask line is one line: a pasted line break becomes a space.
        setDraft((current) => current + pastedLine(text, " "))
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
  // Enter on an empty line goes to the fork, as Enter on an agents row goes
  // to that session.
  const openOnEnter = () => draft().length === 0 && Option.isSome(props.controller.fork())
  // Shown only when a merge can land; the key still answers why it cannot.
  const mergeHint = () => {
    if (props.controller.mergeable()) return [keyHint("ctrl+s", "merge")]
    return []
  }
  const enterHint = () => {
    if (openOnEnter()) return keyHint("enter", "open")
    return KeyHints.submit
  }
  const paneKey = (event: Parameters<Parameters<typeof useScopedKeyboard>[0]>[0]) => {
    if (event.name === "escape") {
      props.onClose()
      return true
    }
    if (event.ctrl && event.name === "s") {
      props.onMerge()
      return true
    }
    if (event.name === "return") {
      if (openOnEnter()) {
        props.onOpen()
        return true
      }
      // A question typed while the fork replies waits in the draft.
      if (!ready()) return true
      const question = draft()
      setDraft("")
      props.controller.ask(question)
      return true
    }
    const edit = lineEdit(event)
    if (Option.isSome(edit)) {
      setDraft(edit.value)
      return true
    }
    const typed = typedKey(event)
    if (Option.isNone(typed)) return false
    setDraft((current) => current + typed.value)
    return true
  }

  const height = () => Math.max(8, Math.floor(dimensions().height / 2))
  const title = () =>
    Option.match(props.controller.fork(), {
      onNone: () => "btw · fork",
      // The fork names itself (`btw: <question>`); a second prefix would double it.
      onSome: (view) => view.name,
    })

  return (
    <Show when={props.open}>
      <PickerFrame
        error={Option.none()}
        height={height()}
        title={title()}
        keys={[enterHint(), ...mergeHint(), KeyHints.close]}
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
      merge: (session) => asMessage(transport.request(ref(BtwRpc.Merge), {}, session)),
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
    // Each opening of the pane is its own: a merge closes the pane it was
    // asked from, never one opened after it.
    const openings = repliesInView(transport.currentSession, sameSession)
    const show = () => {
      openings.take()
      shell.pane.open(BTW_PANE)
      controller.refresh()
    }
    const merge = () => {
      const opening = openings.newest()
      controller.merge(() => opening.write(() => shell.pane.close(BTW_PANE)))
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
      // A merge on the branch the fork came from. The reader sent it, so the
      // transcript pins it as their prompt: what they merged, not its ids.
      messageRendererContribution(
        BTW_MERGE_TYPE,
        (props) => <ForkMergeRow details={props.details} />,
        { prompt: forkMergePrompt, queueLabel: mergeQueueLabel },
      ),
      widgetContribution({
        id: BTW_PANE,
        slot: "below-input",
        component: () => (
          <ForkPane
            open={open()}
            controller={controller}
            onClose={() => shell.pane.close(BTW_PANE)}
            // The fork stays open: `/btw` reopens it, and a later reply merges again.
            onMerge={merge}
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
