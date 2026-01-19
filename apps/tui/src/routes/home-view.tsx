/**
 * Home view - displays logo, handles first message
 */

import { createSignal, onMount } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import figlet from "figlet"
import { useTheme } from "../theme/index.js"
import { useCommand } from "../command/index.js"
import { useClient } from "../client/index.js"
import { useRouter } from "../router/index.js"
import { StatusBar } from "../components/status-bar.js"

const FONTS = ["Slant", "Calvin S", "ANSI Shadow", "Thin"] as const
const FONT = FONTS[Math.floor(Math.random() * FONTS.length)]!
const LOGO = figlet.textSync("gent", { font: FONT })

export interface HomeViewProps {
  initialPrompt?: string
}

export function HomeView(props: HomeViewProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()

  let inputRef: InputRenderable | null = null

  const [, setInputValue] = createSignal("")

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Delete word backward (Option+Backspace)
  const deleteWordBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    let pos = cursor - 1
    while (pos > 0 && value[pos - 1] === " ") pos--
    while (pos > 0 && value[pos - 1] !== " ") pos--

    inputRef.value = value.slice(0, pos) + value.slice(cursor)
    inputRef.cursorPosition = pos
  }

  // Delete line backward (Cmd+Backspace)
  const deleteLineBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    inputRef.value = value.slice(cursor)
    inputRef.cursorPosition = 0
  }

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

    // Option+Backspace / Ctrl+W: delete word backward
    if ((e.meta && e.name === "backspace") || (e.ctrl && e.name === "w")) {
      deleteWordBackward()
      return
    }

    // Cmd+Backspace / Ctrl+U: delete line backward
    if ((e.super && e.name === "backspace") || (e.ctrl && e.name === "u")) {
      deleteLineBackward()
      return
    }
  })

  const handleSubmit = (value: string) => {
    const text = value.trim()
    if (!text) return

    // Send message (will create session if needed)
    void client.sendMessage(text).then(() => {
      const session = client.session()
      if (session) {
        router.navigateToSession(session.sessionId, session.branchId)
      }
    })

    // Clear input
    if (inputRef) {
      inputRef.value = ""
    }
    setInputValue("")
  }

  // Handle initial prompt on mount
  onMount(() => {
    inputRef?.focus()

    if (props.initialPrompt !== undefined && props.initialPrompt !== "") {
      void client.sendMessage(props.initialPrompt).then(() => {
        const session = client.session()
        if (session) {
          router.navigateToSession(session.sessionId, session.branchId)
        }
      })
    }
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Logo */}
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text style={{ fg: theme.textMuted }}>{LOGO}</text>
      </box>

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Input */}
      <box flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text style={{ fg: theme.primary }}>❯ </text>
        <box flexGrow={1}>
          <input
            ref={(r) => (inputRef = r)}
            focused={!command.paletteOpen()}
            onInput={setInputValue}
            onSubmit={handleSubmit}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>
      </box>

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
