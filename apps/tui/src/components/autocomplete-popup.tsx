/**
 * Autocomplete popup for prefix triggers ($, @, /)
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
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
  { id: "model", label: "/model", description: "Switch model" },
  { id: "agent", label: "/agent", description: "Switch agent" },
  { id: "clear", label: "/clear", description: "Clear messages" },
  { id: "sessions", label: "/sessions", description: "Open sessions picker" },
  { id: "compact", label: "/compact", description: "Compact history" },
  { id: "branch", label: "/branch", description: "Create new branch" },
  { id: "tree", label: "/tree", description: "Browse branch tree" },
  { id: "fork", label: "/fork", description: "Fork from a message" },
  { id: "bypass", label: "/bypass", description: "Toggle permission bypass" },
  { id: "permissions", label: "/permissions", description: "View/edit permission rules" },
  { id: "auth", label: "/auth", description: "Manage API keys" },
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

  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let scrollRef: ScrollBoxRenderable | undefined = undefined
  useScrollSync(() => `ac-item-${selectedIndex()}`, { getRef: () => scrollRef })

  // Get items based on type
  const items = (): AutocompleteItem[] => {
    const filter = props.state.filter.toLowerCase()

    switch (props.state.type) {
      case "$": {
        // Skills
        return skills()
          .filter((s) => s.name.toLowerCase().includes(filter))
          .map((s) => ({
            id: s.id,
            label: s.name,
            description: s.source,
          }))
      }

      case "@": {
        // Files - show tag + name, truncated path
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
        // Slash commands
        return SLASH_COMMANDS.filter((c) => c.id.includes(filter) || c.label.includes(filter)).map(
          (c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
          }),
        )
      }
    }
  }

  // Update file search when filter changes
  createEffect(() => {
    if (props.state.type === "@") {
      fileSearch.search(props.state.filter)
    }
  })

  // Reset selection when items change
  createEffect(() => {
    const list = items()
    if (selectedIndex() >= list.length) {
      setSelectedIndex(Math.max(0, list.length - 1))
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

  // Calculate popup height (max 8 items visible)
  const popupHeight = () => Math.min(8, Math.max(1, items().length + 1))

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
      <box
        flexShrink={0}
        height={popupHeight()}
        backgroundColor={theme.backgroundPanel}
        flexDirection="column"
      >
        {/* Header */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>
            {title()}
            <Show when={props.state.filter.length > 0}>
              <span style={{ fg: theme.text }}> › {props.state.filter}</span>
            </Show>
          </text>
        </box>

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
      </box>
    </Show>
  )
}
