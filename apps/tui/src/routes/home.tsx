/**
 * Home route - displays logo, handles first message
 */

import { createEffect, createSignal, onMount } from "solid-js"
import { useRenderer, useTerminalDimensions, useKeyboard } from "@opentui/solid"
import { getLogos } from "../logo.macro.js" with { type: "macro" }
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { StatusBar } from "../components/status-bar"
import { Input } from "../components/input"

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

  const logo = LOGOS[Math.floor(Math.random() * LOGOS.length)]

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  // Track if we're waiting for session creation to navigate
  const [pendingNavigation, setPendingNavigation] = createSignal(false)

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Navigate when session becomes active after pending navigation
  createEffect(() => {
    if (!pendingNavigation()) return
    const session = client.session()
    if (session) {
      setPendingNavigation(false)
      router.navigateToSession(session.sessionId, session.branchId)
    }
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
    if (e.ctrl && e.name === "c") {
      exit()
      return
    }

    // Shift+Tab: cycle agent mode
    if (e.shift && e.name === "tab") {
      const newMode = client.mode() === "build" ? "plan" : "build"
      client.steer({ _tag: "SwitchMode", mode: newMode })
      return
    }
  })

  const handleSubmit = (content: string) => {
    // sendMessage handles session creation
    client.sendMessage(content, client.mode())
    // Set flag so effect navigates when session is ready
    setPendingNavigation(true)
  }

  // Handle initial prompt on mount
  onMount(() => {
    if (props.initialPrompt !== undefined && props.initialPrompt !== "") {
      client.sendMessage(props.initialPrompt, client.mode())
      // Set flag so effect navigates when session is ready
      setPendingNavigation(true)
    }
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Logo */}
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text style={{ fg: theme.textMuted }}>{logo}</text>
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
          <StatusBar.Mode />
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
