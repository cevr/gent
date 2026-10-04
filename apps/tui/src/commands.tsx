/** @jsxImportSource @opentui/solid */
import { Array, Effect, Option, Predicate, Result } from "effect"
import type { Branch } from "@gent/core/protocol"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Show,
} from "solid-js"
import { formatError, shortId, truncate, truncateStart, useRequiredContext } from "./utils"
import { useTerminalDimensions } from "./terminal"
import { matchSorter } from "match-sorter"
import { useClient, useRuntime } from "./client"
import {
  keyHint,
  KeyHints,
  PickerFrame,
  selectable,
  SelectList,
  type SelectListApi,
  type SelectListRow,
} from "./ui"
import { textWidth } from "./bun-adapter"
import { useTheme } from "./theme"
import { useExtensionUI } from "./extensions/host"
import { type Keybind, parseKeybind } from "./extensions/loader-boundary"
import type { Command } from "./extensions/client-facets"

// ── command types ───────────────────────────────────────────────────────────

// A command's shape is its contribution schema's (`client-facets.ts`): the
// loader decodes an extension's commands with it, so the type has one owner.
export type { Command }

/**
 * A keybind with no ctrl or meta is a key the composer also reads: an arrow
 * moves its cursor. It belongs to a command only while the composer is idle;
 * otherwise the composer keeps it. A key that types a character never gets
 * here: `resolveCommands` refuses it.
 */
const isBareKeybind = (keybind: Keybind): boolean => !keybind.ctrl && !keybind.meta

function matchKeybind(
  keybind: Keybind,
  event: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean },
): boolean {
  return (
    keybind.key === event.name.toLowerCase() &&
    keybind.ctrl === (event.ctrl ?? false) &&
    keybind.shift === (event.shift ?? false) &&
    keybind.meta === (event.meta ?? false)
  )
}

// ── palette and keybinds ────────────────────────────────────────────────────

/**
 * Whether the palette is open, and the key dispatch over the resolved
 * commands. The commands themselves live on `useExtensionUI().commands()`.
 */
interface CommandContextValue {
  handleKeybind: (
    event: {
      name: string
      ctrl?: boolean
      shift?: boolean
      meta?: boolean
    },
    commands: ReadonlyArray<Command>,
    /**
     * The composer holds no draft and nothing else holds the keys (no
     * overlay, pane, shell mode or interaction). Only then does a bare
     * keybind fire.
     */
    composerIdle: boolean,
  ) => boolean
  paletteOpen: Accessor<boolean>
  openPalette: () => void
  closePalette: () => void
}

const CommandContext = createContext<CommandContextValue>()

export function useCommand(): CommandContextValue {
  return useRequiredContext(CommandContext, "useCommand must be used within CommandProvider")
}

interface CommandProviderProps {
  children: JSX.Element
}

export function CommandProvider(props: CommandProviderProps) {
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  const handleKeybind = (
    event: {
      name: string
      ctrl?: boolean
      shift?: boolean
      meta?: boolean
    },
    commands: ReadonlyArray<Command>,
    composerIdle: boolean,
  ): boolean => {
    // Check for palette keybind (Ctrl+P)
    if (event.ctrl === true && event.name === "p" && event.shift !== true && event.meta !== true) {
      setPaletteOpen(true)
      return true
    }

    // Don't process keybinds when palette is open
    if (paletteOpen()) return false

    for (const cmd of commands) {
      const kb = Option.flatMap(Option.fromNullishOr(cmd.keybind), parseKeybind).pipe(
        Option.filter((keybind) => composerIdle || !isBareKeybind(keybind)),
      )
      if (Option.isSome(kb) && matchKeybind(kb.value, event)) {
        cmd.onSelect()
        return true
      }
    }
    return false
  }

  const value: CommandContextValue = {
    handleKeybind,
    paletteOpen,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
  }

  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>
}

// ── slash commands ──────────────────────────────────────────────────────────

/**
 * The command `/name` names, case-insensitively: the one whose `slash` it is,
 * else the one that lists it among its `aliases`. Resolution leaves one owner
 * per slash, so a slash beats an alias another command still carries.
 */
const findSlashCommand = (
  cmd: string,
  commands: ReadonlyArray<Command>,
): Option.Option<Command> => {
  const lowerCmd = cmd.toLowerCase()
  const bySlash = commands.find((c) => c.slash?.toLowerCase() === lowerCmd)
  if (Predicate.isNotUndefined(bySlash)) return Option.some(bySlash)
  return Option.fromNullishOr(
    commands.find((c) => (c.aliases ?? []).some((alias) => alias.toLowerCase() === lowerCmd)),
  )
}

/**
 * Runs the command `/cmd` names with `args`. Answers whether one ran: a name
 * no command carries runs nothing.
 */
export const executeSlashCommand = (
  cmd: string,
  args: string,
  commands: ReadonlyArray<Command>,
): boolean =>
  Option.match(findSlashCommand(cmd, commands), {
    onNone: () => false,
    onSome: (command) => {
      const onSlash = Option.fromNullishOr(command.onSlash)
      if (Option.isSome(onSlash)) onSlash.value(args)
      else command.onSelect()
      return true
    },
  })

/** A line's command name and the rest, trimmed; `None` for a line that does not start with `/`. */
export const parseSlashCommand = (input: string): Option.Option<readonly [string, string]> => {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return Option.none()
  const spaceIdx = trimmed.indexOf(" ")
  if (spaceIdx === -1) return Option.some([trimmed.slice(1), ""])
  return Option.some([trimmed.slice(1, spaceIdx), trimmed.slice(spaceIdx + 1).trim()])
}

/**
 * Whether `/name` is a resolved slash command, matched like
 * {@link executeSlashCommand} does.
 *
 * The composer asks this to decide whether completing a slash name should
 * dispatch the command or only insert its text. No command in this repo
 * requires an argument: the arg-aware ones (`/model`, `/effort`, `/goal`,
 * `/driver`, `/btw`) all treat an empty arg as "open my picker" or
 * "show usage", so naming a command is always enough to run it.
 */
export const isSlashCommandName = (cmd: string, commands: ReadonlyArray<Command>): boolean =>
  Option.isSome(findSlashCommand(cmd, commands))

// ── palette state ───────────────────────────────────────────────────────────

/** A menu item in the command palette. */
interface PaletteItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly shortcut?: string
  /** The command's slash name and aliases: the search finds the row by them too. */
  readonly slashNames?: ReadonlyArray<string>
  readonly onSelect: () => void
}

/**
 * A level's rows: `None` while its request is pending, else the rows or the
 * reason the request failed.
 */
type LevelRows = Option.Option<Result.Result<readonly PaletteItem[], string>>

const levelRows = (items: readonly PaletteItem[]): LevelRows => Option.some(Result.succeed(items))

/** A structural level in the palette stack; `source` is a Solid accessor. */
interface PaletteLevel {
  readonly id: string
  readonly title: string
  readonly source: Accessor<LevelRows>
}

/**
 * What the palette owns beyond its list: the level stack and the category
 * lens on the current level. The query and the cursor belong to the
 * `SelectList` it mounts.
 */
interface CommandPaletteState {
  readonly levelStack: readonly PaletteLevel[]
  readonly category: string
}

/** A closed palette: no level open, no category lens. */
const closedPalette: CommandPaletteState = { levelStack: [], category: "" }

// ── command palette ─────────────────────────────────────────────────────────

/**
 * The palette search. A query may spell a command as the composer does, with
 * its "/": one leading "/" is dropped, as `slashNames` hold the names without it.
 */
const filterItems = (items: readonly PaletteItem[], query: string): readonly PaletteItem[] => {
  const search = query.replace(/^\//, "")
  if (search.length === 0) return items
  return matchSorter(items, search, {
    keys: ["title", "slashNames", "description", "category"],
  })
}

/**
 * The name column of a picker row that also draws a description: the longest
 * name and a gap of 2, so a name stays whole while the description gives way,
 * up to 60 % of `width` and at least 8. The palette and the `/` popup share it.
 */
export const nameColumnWidth = (names: ReadonlyArray<string>, width: number): number => {
  const longest = names.reduce((widest, name) => Math.max(widest, textWidth(name)), 0)
  return Math.max(8, Math.min(longest + 2, Math.floor(width * 0.6)))
}

const selectedTitle = (title: string, selected: boolean): string => {
  if (selected) return `${title} •`
  return title
}

export function CommandPalette() {
  const command = useCommand()
  const ext = useExtensionUI()
  const { theme, selected, set, all, mode, setMode } = useTheme()
  const client = useClient()
  const { cast } = useRuntime()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(closedPalette)
  // The list owns the query and the cursor; the palette keeps a copy of the
  // query to filter with and a handle to reset the list when a level changes.
  const [searchQuery, setSearchQuery] = createSignal("")
  let list = Option.none<SelectListApi>()
  const resetList = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.reset() })
  const listToTop = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.moveTo(0) })

  const closePalette = () => {
    setState(closedPalette)
    command.closePalette()
  }

  // ── Level factories ──

  // Theme and mode are orthogonal: `set(name)` picks the catalog entry and
  // `setMode` picks the variant it resolves in. "System" is a catalog entry
  // like any other — the one generated from the terminal's palette — so
  // following the terminal stays a theme choice, not a third mode.
  const themeLevel = (): PaletteLevel => ({
    id: "theme",
    title: "Theme",
    source: () => {
      const active = selected()
      const named = Object.keys(all())
        .filter((name) => name !== "system")
        .map((name) => ({
          id: `theme.${name}`,
          title: selectedTitle(name, active === name),
          onSelect: () => {
            set(name)
            closePalette()
          },
        }))
      return levelRows([
        {
          id: "theme.system",
          title: selectedTitle("System", active === "system"),
          description: "Follow terminal theme",
          onSelect: () => {
            set("system")
            closePalette()
          },
        },
        ...named,
      ])
    },
  })

  // Dark/Light is the variant every theme resolves in, so it is its own level
  // rather than three entries mixed into the theme list.
  const modeLevel = (): PaletteLevel => ({
    id: "mode",
    title: "Mode",
    source: () => {
      const current = mode()
      const item = (value: "dark" | "light", title: string): PaletteItem => ({
        id: `mode.${value}`,
        title: selectedTitle(title, current === value),
        onSelect: () => {
          setMode(value)
          closePalette()
        },
      })
      return levelRows([item("dark", "Dark"), item("light", "Light")])
    },
  })

  // The list is read once per open. A failed read is the level's answer: the
  // palette stays open and its row says why.
  const branchesLevel = (): PaletteLevel => {
    const [branches, setBranches] = createSignal<
      Option.Option<Result.Result<readonly Branch[], string>>
    >(Option.none())
    cast(
      client.listBranches.pipe(
        Effect.match({
          onFailure: (error) =>
            setBranches(Option.some(Result.fail(`Branches: ${formatError(error)}`))),
          onSuccess: (items) => setBranches(Option.some(Result.succeed(items))),
        }),
      ),
    )
    const isCurrent = (branch: Branch) => client.sessionIdentity().branchId === branch.id
    return {
      id: "branches",
      title: "Branches",
      source: () =>
        Option.map(
          branches(),
          Result.map((items) =>
            items.map((branch) => ({
              id: `branch.${branch.id}`,
              title: selectedTitle(
                branch.name ?? `Branch ${shortId(branch.id)}`,
                isCurrent(branch),
              ),
              onSelect: () => {
                if (!isCurrent(branch)) client.switchBranch(branch.id)
                closePalette()
              },
            })),
          ),
        ),
    }
  }

  const pushLevel = (level: PaletteLevel) => {
    setState((current) => ({ levelStack: [...current.levelStack, level], category: "" }))
    resetList()
  }

  const rootLevel = (): PaletteLevel => ({
    id: "root",
    title: "Commands",
    source: () =>
      levelRows([
        {
          id: "theme",
          title: "Theme",
          description: "Switch color theme",
          category: "Appearance",
          onSelect: () => pushLevel(themeLevel()),
        },
        {
          id: "mode",
          title: "Mode",
          description: "Dark or light variant",
          category: "Appearance",
          onSelect: () => pushLevel(modeLevel()),
        },
        {
          id: "branches",
          title: "Branches",
          description: "Switch branches in this session",
          category: "Session",
          onSelect: () => pushLevel(branchesLevel()),
        },
        ...ext.commands().map((cmd) => ({
          id: `ext:${cmd.id}`,
          title: cmd.title,
          description: cmd.description,
          category: cmd.category ?? "General",
          shortcut: cmd.keybind,
          slashNames: [
            ...Option.toArray(Option.fromUndefinedOr(cmd.slash)),
            ...(cmd.aliases ?? []),
          ],
          onSelect: () => {
            cmd.onSelect()
            closePalette()
          },
        })),
      ]),
  })

  // ── Derived state ──

  const currentLevel = () => Array.last(state().levelStack)

  const levelSource = createMemo(() => Option.flatMap(currentLevel(), (level) => level.source()))
  const loading = () => Option.isNone(levelSource())
  /** Why the level's request failed. */
  const levelFailure = () => Option.flatMap(levelSource(), Result.getFailure)
  const levelItems = createMemo<readonly PaletteItem[]>(() =>
    Option.getOrElse(Option.flatMap(levelSource(), Result.getSuccess), () => []),
  )

  const categories = createMemo(() => [
    "",
    ...new Set(levelItems().map((item) => item.category ?? "General")),
  ])
  const category = () => {
    if (categories().includes(state().category)) return state().category
    return ""
  }
  const filteredItems = createMemo(() => {
    const items = filterItems(levelItems(), searchQuery())
    if (category() === "") return items
    return items.filter((item) => (item.category ?? "General") === category())
  })
  const categoryHeader = () => {
    const selected = category()
    const label = selected || "All"
    const others = categories()
      .filter((value) => value !== selected)
      .map((value) => value || "All")
    return `[${label}]  ${others.join("  ")}`
  }

  const popLevel = () => {
    if (state().levelStack.length <= 1) {
      closePalette()
      return
    }
    setState((current) => ({ levelStack: current.levelStack.slice(0, -1), category: "" }))
    resetList()
  }

  const handleSelect = (item: PaletteItem) => {
    item.onSelect()
  }

  const cycleCategory = (backward: boolean) => {
    const items = categories()
    let step = 1
    if (backward) step = -1
    const index = (items.indexOf(category()) + step + items.length) % items.length
    const next = Option.getOrElse(Option.fromNullishOr(items[index]), () => "")
    setState((current) => ({ ...current, category: next }))
    listToTop()
  }

  createEffect(() => {
    if (command.paletteOpen()) {
      setState({ levelStack: [rootLevel()], category: "" })
    }
  })

  const hasDetails = () =>
    filteredItems().some((item) => Boolean(item.description?.trim() || item.shortcut))
  // The name column fits the longest name in view, up to 60% of the row, and
  // the description gives way: a name is what the reader picks by.
  const labelWidth = () => {
    if (!hasDetails()) return dimensions().width
    return nameColumnWidth(
      filteredItems().map((item) => item.title),
      dimensions().width,
    )
  }

  const keys = () => {
    let leave = KeyHints.close
    if (state().levelStack.length > 1) leave = KeyHints.back
    return [KeyHints.move, keyHint("tab", "category"), KeyHints.select, leave]
  }

  const breadcrumb = () => {
    const stack = state().levelStack
    if (stack.length <= 1) return ""
    return (
      stack
        .slice(0, -1)
        .map((level) => level.title)
        .join(" › ") + " ›"
    )
  }

  const levelTitle = () =>
    Option.match(currentLevel(), {
      onNone: () => "Commands",
      onSome: (level) => level.title,
    })

  const paletteTitle = () => `${levelTitle()} ${filteredItems().length} ${categoryHeader()}`

  const queryPrefix = () => {
    if (searchQuery().length === 0) return truncate(breadcrumb(), dimensions().width - 2)
    const available = Math.max(1, Math.floor((dimensions().width - 3) / 2))
    return `${truncate(breadcrumb() || "›", available)} `
  }
  const visibleQuery = () =>
    truncateStart(searchQuery(), dimensions().width - 3 - textWidth(queryPrefix()))

  const rows = (): ReadonlyArray<SelectListRow<PaletteItem>> =>
    filteredItems().map((item) =>
      selectable(item, (isSelected, id) => {
        const itemTextColor = () => {
          if (isSelected()) return theme.primary
          return theme.text
        }
        const metaColor = () => {
          if (isSelected()) return theme.primary
          return theme.textMuted
        }
        const detail = () => {
          let text = Option.getOrElse(Option.fromNullishOr(item.description), () => "")
          if (item.shortcut) text += ` [${item.shortcut}]`
          return truncate(text, dimensions().width - labelWidth() - 3)
        }
        return (
          <box id={id} paddingLeft={1} flexDirection="row" height={1} gap={2}>
            <text
              width={labelWidth() - 2}
              flexShrink={0}
              wrapMode="none"
              truncate
              style={{ fg: itemTextColor() }}
            >
              <span style={{ bold: isSelected() }}>{truncate(item.title, labelWidth() - 2)}</span>
            </text>
            <Show when={hasDetails()}>
              <text flexGrow={1} wrapMode="none" truncate style={{ fg: metaColor() }}>
                {detail()}
              </text>
            </Show>
          </box>
        )
      }),
    )

  // A level whose source failed says why; the list owns every other empty row.
  const failureRow = () =>
    Option.map(levelFailure(), (failure) => (
      <box paddingLeft={1}>
        <text wrapMode="none" truncate style={{ fg: theme.error }}>
          {failure}
        </text>
      </box>
    ))

  return (
    <Show when={command.paletteOpen()}>
      <PickerFrame title={paletteTitle()} keys={keys()} error={Option.none()}>
        <SelectList
          id="command-palette"
          queryRow={() => (
            <text height={1} wrapMode="none" truncate style={{ fg: theme.text }}>
              <span style={{ fg: theme.textMuted }}>{queryPrefix()}</span>
              <Show when={searchQuery().length > 0}>
                {visibleQuery()}
                <span style={{ fg: theme.primary }}>│</span>
              </Show>
            </text>
          )}
          open={command.paletteOpen()}
          rows={rows}
          rowKey={(item) => item.id}
          filter={{ onQueryChange: setSearchQuery }}
          loading={loading}
          empty={failureRow}
          api={(api) => (list = Option.some(api))}
          extraKeys={(event, selected) => {
            if (event.name === "tab") {
              cycleCategory(event.shift === true)
              return true
            }
            if (event.name === "left") {
              popLevel()
              return true
            }
            // Backspace on an empty query walks back a level; the list keeps it otherwise.
            if (event.name === "backspace" && searchQuery().length === 0) {
              if (state().levelStack.length <= 1) return false
              popLevel()
              return true
            }
            if (event.name === "right") {
              Option.match(selected, { onNone: () => {}, onSome: handleSelect })
              return true
            }
            return false
          }}
          onSelect={handleSelect}
          onDismiss={popLevel}
        />
      </PickerFrame>
    </Show>
  )
}
