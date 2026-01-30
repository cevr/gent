/**
 * Home route - displays logo, handles first message
 */

import { createEffect, createSignal, onMount, Show } from "solid-js"
import { useRenderer, useTerminalDimensions, useKeyboard } from "@opentui/solid"
import { Effect } from "effect"
import { getLogos } from "../logo.macro.js" with { type: "macro" }
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { StatusBar } from "../components/status-bar"
import { Input } from "../components/input"
import { useRuntime } from "../hooks/use-runtime"

const LOGOS = getLogos()

export interface HomeProps {
  initialPrompt?: string
}

export function Home(props: HomeProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.runtime)

  const logo = LOGOS[Math.floor(Math.random() * LOGOS.length)]

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  // Track pending prompt while session is created
  const [pendingPrompt, setPendingPrompt] = createSignal<string | null>(null)
  const [showWelcome, setShowWelcome] = createSignal(false)
  const [needsAuth, setNeedsAuth] = createSignal(false)

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Navigate when session becomes active after pending prompt
  createEffect(() => {
    const prompt = pendingPrompt()
    const session = client.session()
    if (prompt === null || session === null) return
    setPendingPrompt(null)
    router.navigateToSession(session.sessionId, session.branchId, prompt)
  })

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

    // ESC: double-tap to quit
    if (e.name === "escape") {
      if (command.paletteOpen()) {
        command.closePalette()
        return
      }

      const now = Date.now()
      if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
        exit()
      } else {
        lastEscTime = now
      }
      return
    }

    // Ctrl+C: always quit immediately
    if (e.ctrl === true && e.name === "c") {
      exit()
      return
    }

    // Shift+Tab: toggle agent (cowork <-> deep)
    if (e.shift === true && e.name === "tab") {
      const nextAgent = client.agent() === "deep" ? "cowork" : "deep"
      client.steer({ _tag: "SwitchAgent", agent: nextAgent })
      return
    }
  })

  const handleSubmit = (content: string, _mode?: "queue" | "interject") => {
    // Create session, navigate with pending prompt for session route to send
    setPendingPrompt(content)
    client.createSession()
  }

  // Handle initial prompt on mount
  onMount(() => {
    if (props.initialPrompt !== undefined && props.initialPrompt !== "") {
      setPendingPrompt(props.initialPrompt)
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
          if (!firstRun) setNeedsAuth(false)
        })
        if (!firstRun) return

        const providers = yield* client.client.listAuthProviders()
        const hasKey = providers.some(
          (provider) => provider.hasKey && provider.provider !== "bedrock",
        )
        yield* Effect.sync(() => {
          setNeedsAuth(!hasKey)
        })
      }).pipe(
        Effect.catchAll(() =>
          Effect.sync(() => {
            setShowWelcome(false)
            setNeedsAuth(false)
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
        <Show when={showWelcome()}>
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

      {/* Input with autocomplete above separator */}
      <Input onSubmit={handleSubmit}>
        <Input.Autocomplete />
        {/* Separator line */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
        </box>
      </Input>

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Status Bar */}
      <StatusBar.Root>
        <StatusBar.Row>
          <StatusBar.Agent />
          <StatusBar.Separator />
          <StatusBar.Model />
        </StatusBar.Row>
        <StatusBar.Row>
          <StatusBar.Cwd />
          <StatusBar.Separator />
          <StatusBar.Git />
          <StatusBar.Separator />
          <StatusBar.Cost />
        </StatusBar.Row>
      </StatusBar.Root>
    </box>
  )
}
