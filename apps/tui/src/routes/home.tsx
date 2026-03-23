/**
 * Home route - displays logo, handles first message
 */

import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { Effect } from "effect"
import { getLogos } from "../logo.macro.js" with { type: "macro" }
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { Input } from "../components/input"
import { useRuntime } from "../hooks/use-runtime"
import { useExit } from "../hooks/use-exit"
import { executeSlashCommand } from "../commands/slash-commands"
import { ClientError, formatError, type UiError } from "../utils/format-error"
import { useWorkspace } from "../workspace/index"
import { BorderedInput, formatCwdGit, type BorderLabelItem } from "../components/bordered-input"
import { useKeyChain } from "../hooks/use-key-chain"
import { PromptSearchPalette } from "../components/prompt-search-palette"
import { buildTopRightLabels } from "../utils/session-labels"
import { useScopedKeyboard } from "../keyboard/context"
import {
  PromptSearchState,
  transitionPromptSearch,
  type PromptSearchEvent,
} from "../components/prompt-search-state"
import { usePromptHistory } from "../hooks/use-prompt-history"

const LOGOS = getLogos()

export interface HomeProps {
  initialPrompt?: string
  debugMode?: boolean
}

type HomeState =
  | {
      _tag: "idle"
      showWelcome: boolean
      promptSearch: PromptSearchState
    }
  | {
      _tag: "pending"
      prompt: string
      showWelcome: boolean
      promptSearch: PromptSearchState
    }

export function Home(props: HomeProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.services)
  const { exit, handleEsc } = useExit()
  const quitChain = useKeyChain()
  const workspace = useWorkspace()
  const history = usePromptHistory()

  const cwdGitLabel = () =>
    formatCwdGit(workspace.cwd, workspace.gitRoot(), workspace.gitStatus()?.branch)

  const logo = LOGOS[Math.floor(Math.random() * LOGOS.length)]

  // Track pending prompt while session is created
  const [state, setState] = createSignal<HomeState>({
    _tag: "idle",
    showWelcome: false,
    promptSearch: PromptSearchState.closed(),
  })
  const [authProviders, setAuthProviders] = createSignal<
    { hasKey: boolean; provider: string; required: boolean }[]
  >([])
  const [composerText, setComposerText] = createSignal("")
  const [restoreTextRequest, setRestoreTextRequest] = createSignal<
    { token: number; text: string } | undefined
  >(undefined)
  const promptSearchState = () => state().promptSearch
  const promptSearchOpen = () => promptSearchState()._tag === "open"

  const needsAuth = createMemo(() => {
    const providers = authProviders()
    if (providers.length === 0) return false
    return !providers.some((p) => p.hasKey && p.provider !== "bedrock")
  })

  const setShowWelcome = (showWelcome: boolean) => {
    setState((prev) => {
      switch (prev._tag) {
        case "idle":
          return {
            _tag: "idle",
            showWelcome,
            promptSearch: prev.promptSearch,
          }
        case "pending":
          return {
            _tag: "pending",
            prompt: prev.prompt,
            showWelcome,
            promptSearch: prev.promptSearch,
          }
      }
    })
  }

  const dispatchPromptSearch = (event: PromptSearchEvent) => {
    const result = transitionPromptSearch(promptSearchState(), event, history.entries())
    setState((prev) => ({ ...prev, promptSearch: result.state }))
    for (const effect of result.effects) {
      if (effect._tag === "Preview") {
        setRestoreTextRequest({ token: Date.now(), text: effect.text })
      }
    }
  }

  // Navigate when session becomes active after pending prompt
  createEffect(() => {
    const current = state()
    if (current._tag !== "pending") return
    const session = client.session()
    if (session === null) return
    setState((prev) =>
      prev._tag === "pending"
        ? {
            _tag: "idle",
            showWelcome: prev.showWelcome,
            promptSearch: prev.promptSearch,
          }
        : prev,
    )
    router.navigateToSession(session.sessionId, session.branchId, current.prompt)
  })

  useScopedKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return true

    const clearComposer = () => {
      setRestoreTextRequest({ token: Date.now(), text: "" })
    }

    const handleQuitKey = (chainId: string) => {
      if (composerText().length > 0) {
        quitChain.trigger(chainId, {
          first: clearComposer,
          second: exit,
        })
        return
      }

      quitChain.trigger(chainId, {
        first: () => {
          handleEsc()
        },
        second: exit,
      })
    }

    // ESC: double-tap to quit
    if (e.name === "escape") {
      if (promptSearchOpen()) {
        dispatchPromptSearch({ _tag: "Cancel" })
        quitChain.reset()
        return true
      }

      if (command.paletteOpen()) {
        command.closePalette()
        quitChain.reset()
        return true
      }

      handleQuitKey("escape")
      return true
    }

    // Ctrl+C: clear composer first, then quit
    if (e.ctrl === true && e.name === "c") {
      handleQuitKey("ctrl+c")
      return true
    }

    if (e.ctrl === true && e.name === "r") {
      dispatchPromptSearch({ _tag: "Open", draftBeforeOpen: composerText() })
      quitChain.reset()
      return true
    }
    return false
  })

  const createNewSession = (): Effect.Effect<void, UiError> =>
    client.client
      .createSession({
        cwd: workspace.cwd,
      })
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            client.switchSession(result.sessionId, result.branchId, result.name, result.bypass)
            router.navigateToSession(result.sessionId, result.branchId)
          }),
        ),
        Effect.asVoid,
        Effect.catchEager((error) => Effect.fail(ClientError(formatError(error)))),
      )

  const handleSlashCommand = (cmd: string, args: string): Effect.Effect<void, UiError> =>
    executeSlashCommand(cmd, args, {
      openPalette: () => command.openPalette(),
      clearMessages: () => {},
      navigateToSessions: () => command.openPalette(),
      createBranch: Effect.fail(ClientError("No active session")),
      openTree: () => {},
      openFork: () => {},
      toggleBypass: Effect.fail(ClientError("No active session")),
      setReasoningLevel: () => Effect.fail(ClientError("No active session")),
      openPermissions: () => {},
      openAuth: () => router.navigateToAuth(),
      sendMessage: (content: string) => client.sendMessage(content),
      newSession: () => createNewSession(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.error !== undefined) {
            client.setError(result.error)
          }
        }),
      ),
      Effect.asVoid,
    )

  const handleSubmit = (content: string, _mode?: "queue" | "interject") => {
    // Create session, navigate with pending prompt for session route to send
    setState((prev) => ({
      _tag: "pending",
      prompt: content,
      showWelcome: prev.showWelcome,
      promptSearch: prev.promptSearch,
    }))
    client.createSession()
  }

  // Handle initial prompt on mount
  onMount(() => {
    if (props.initialPrompt !== undefined && props.initialPrompt !== "") {
      const prompt = props.initialPrompt
      setState((prev) => ({
        _tag: "pending",
        prompt,
        showWelcome: prev.showWelcome,
        promptSearch: prev.promptSearch,
      }))
      client.createSession()
    }
  })

  onMount(() => {
    cast(
      Effect.gen(function* () {
        const sessions = yield* client.listSessions()
        const firstRun = sessions.length === 0
        yield* Effect.sync(() => {
          setShowWelcome(firstRun)
        })
        if (!firstRun) return

        const providers = yield* client.client.listAuthProviders()
        yield* Effect.sync(() => {
          setAuthProviders(
            providers.map((p) => ({
              hasKey: p.hasKey,
              provider: p.provider,
              required: p.required,
            })),
          )
        })
      }).pipe(
        Effect.catchEager(() =>
          Effect.sync(() => {
            setShowWelcome(false)
          }),
        ),
      ),
    )
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Logo */}
      <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
        <text style={{ fg: theme.textMuted }}>{logo}</text>
        <Show when={state().showWelcome}>
          <box paddingTop={1} flexDirection="column" alignItems="center">
            <text style={{ fg: theme.text }}>Welcome to gent</text>
            <text style={{ fg: theme.textMuted }}>Type a prompt to start.</text>
            <Show
              when={needsAuth()}
              fallback={
                <text style={{ fg: theme.textMuted }}>
                  Use /auth for keys, /permissions for rules
                </text>
              }
            >
              <text style={{ fg: theme.warning }}>No API keys found. Run /auth.</text>
            </Show>
          </box>
        </Show>
      </box>

      {/* Bordered input */}
      <BorderedInput
        topRight={
          buildTopRightLabels(client.agent(), undefined, 0, undefined, theme, {
            debugMode: props.debugMode,
          }) satisfies BorderLabelItem[]
        }
        bottomRight={[{ text: cwdGitLabel(), color: theme.textMuted }]}
        borderColor={props.debugMode === true ? theme.warning : theme.border}
      >
        <Input
          onSubmit={handleSubmit}
          onSlashCommand={handleSlashCommand}
          suspended={promptSearchOpen()}
          onTextChange={setComposerText}
          restoreTextRequest={restoreTextRequest()}
        >
          <Input.Autocomplete />
        </Input>
      </BorderedInput>

      <PromptSearchPalette
        state={promptSearchState()}
        entries={history.entries()}
        onEvent={dispatchPromptSearch}
      />
    </box>
  )
}
