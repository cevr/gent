/**
 * Autocomplete popup for prefix triggers ($, @, /)
 */

import { createSignal, createEffect, createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useWorkspace } from "../workspace/index"
import { useSkills } from "../hooks/use-skills"
import { useFileSearch } from "../hooks/use-file-search"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncatePath } from "./message-list-utils"

/** Get file type tag from extension */
function getFileTag(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
      return "[ts]"
    case "js":
    case "jsx":
      return "[js]"
    case "md":
    case "mdx":
      return "[md]"
    case "json":
      return "[json]"
    case "css":
    case "scss":
    case "less":
      return "[css]"
    case "html":
      return "[html]"
    case "py":
      return "[py]"
    case "rs":
      return "[rs]"
    case "go":
      return "[go]"
    case "yaml":
    case "yml":
      return "[yaml]"
    case "toml":
      return "[toml]"
    case "sh":
    case "bash":
    case "zsh":
      return "[sh]"
    default:
      return ""
  }
}

export type AutocompleteType = "$" | "@" | "/"

export interface AutocompleteState {
  type: AutocompleteType
  filter: string
  triggerPos: number
}

export interface AutocompleteItem {
  id: string
  label: string
  description?: string
}

interface SlashCommand {
  id: string
  label: string
  description: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "agent", label: "/agent", description: "Switch agent" },
  { id: "clear", label: "/clear", description: "Clear messages" },
  { id: "sessions", label: "/sessions", description: "Open sessions picker" },
  { id: "branch", label: "/branch", description: "Create new branch" },
  { id: "tree", label: "/tree", description: "Browse branch tree" },
  { id: "fork", label: "/fork", description: "Fork from a message" },
  { id: "bypass", label: "/bypass", description: "Toggle permission bypass" },
  { id: "permissions", label: "/permissions", description: "View/edit permission rules" },
  { id: "auth", label: "/auth", description: "Manage API keys" },
  { id: "handoff", label: "/handoff", description: "Distill context into new session" },
  { id: "counsel", label: "/counsel", description: "Opposite-vendor peer review" },
  { id: "loop", label: "/loop", description: "Iterate until condition met" },
  { id: "plan", label: "/plan", description: "Adversarial dual-model planning" },
  { id: "audit", label: "/audit", description: "Detect, audit, fix code issues" },
]

export interface AutocompletePopupProps {
  state: AutocompleteState
  onSelect: (value: string) => void
  onClose: () => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const workspace = useWorkspace()
  const { skills } = useSkills()
  const fileSearch = useFileSearch({ cwd: workspace.cwd })

  const [rawSelectedIndex, setSelectedIndex] = createSignal(0)

  let scrollRef: ScrollBoxRenderable | undefined = undefined

  // Memoize filtered items to avoid recomputation on each access
  const items = createMemo((): AutocompleteItem[] => {
    const filter = props.state.filter.toLowerCase()

    switch (props.state.type) {
      case "$": {
        return skills()
          .filter((s) => s.name.toLowerCase().includes(filter))
          .map((s) => ({
            id: s.name,
            label: s.name,
            description:
              s.description.length > 60 ? s.description.slice(0, 60) + "…" : s.description,
          }))
      }

      case "@": {
        return fileSearch.results().map((f) => {
          const tag = getFileTag(f.path)
          return {
            id: f.path,
            label: tag.length > 0 ? `${tag} ${f.name}` : f.name,
            description: truncatePath(f.path, 40),
          }
        })
      }

      case "/": {
        return SLASH_COMMANDS.filter((c) => c.id.includes(filter) || c.label.includes(filter)).map(
          (c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
          }),
        )
      }
    }
  })

  // Clamp index reactively instead of via createEffect
  const selectedIndex = createMemo(() => {
    const list = items()
    const idx = rawSelectedIndex()
    return idx >= list.length ? Math.max(0, list.length - 1) : idx
  })

  useScrollSync(() => `ac-item-${selectedIndex()}`, { getRef: () => scrollRef })

  // Update file search when filter changes
  createEffect(() => {
    if (props.state.type === "@") {
      fileSearch.search(props.state.filter)
    }
  })

  // Handle keyboard navigation
  useKeyboard((e) => {
    const list = items()
    if (list.length === 0) return

    if (e.name === "escape") {
      props.onClose()
      return
    }

    if (e.name === "return" || e.name === "tab") {
      const item = list[selectedIndex()]
      if (item !== undefined) {
        props.onSelect(item.id)
      }
      return
    }

    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
      return
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
      return
    }
  })

  const dimensions = useTerminalDimensions()

  // Content-driven height with floor/cap
  const popupHeight = () => {
    const contentH = items().length + 3 // items + header + filter hint + footer
    return Math.min(14, Math.max(5, contentH))
  }

  const popupWidth = () => Math.min(60, dimensions().width - 2)
  const popupLeft = () => Math.floor((dimensions().width - popupWidth()) / 2)

  const title = () => {
    switch (props.state.type) {
      case "$":
        return "Skills"
      case "@":
        return "Files"
      case "/":
        return "Commands"
    }
  }

  return (
    <Show when={items().length > 0}>
      {/* Transparent backdrop */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Popup */}
      <box
        position="absolute"
        left={popupLeft()}
        bottom={3}
        width={popupWidth()}
        height={popupHeight()}
        backgroundColor={theme.background}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={title()}
      >
        {/* Filter display */}
        <Show when={props.state.filter.length > 0}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.textMuted }}>
              › <span style={{ fg: theme.text }}>{props.state.filter}</span>
            </text>
          </box>
        </Show>

        {/* Items */}
        <scrollbox ref={scrollRef} flexGrow={1}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              return (
                <box
                  id={`ac-item-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                  flexDirection="row"
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {item.label}
                  </text>
                  <Show when={item.description !== undefined}>
                    <text
                      style={{
                        fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                      }}
                    >
                      {" "}
                      {item.description}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>

        {/* Footer hints */}
        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>↑↓ navigate · enter select · esc close</text>
        </box>
      </box>
    </Show>
  )
}
