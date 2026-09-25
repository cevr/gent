/** @jsxImportSource @opentui/solid */
import { Array, Match, Option, Predicate, Schema } from "effect"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type JSX,
  Show,
} from "solid-js"
import { shortId, truncate, truncateStart, useRequiredContext } from "./utils"
import { useTerminalDimensions } from "./terminal"
import { matchSorter } from "match-sorter"
import { useClient } from "./client"
import { PickerFrame, selectable, SelectList, type SelectListApi, type SelectListRow } from "./ui"
import { textWidth } from "./text-width-adapter"
import { useTheme } from "./theme"
import { useExtensionUI } from "./extensions/host"
import { type Keybind, parseKeybind } from "./extensions/loader-boundary"

// ── command types ───────────────────────────────────────────────────────────

/**
 * One command: a palette row, and optionally a keybind and a slash name. The
 * session's own commands, client extension commands and server slash commands
 * all take this shape and resolve under one rule (`resolveCommands`).
 */
export interface Command {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly keybind?: string
  /** Slash command trigger (without the /). When set, /name invokes onSlash (or onSelect if no onSlash). */
  readonly slash?: string
  /** Additional slash names that resolve to this command */
  readonly aliases?: readonly string[]
  readonly onSelect: () => void
  /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
  readonly onSlash?: (args: string) => void
}

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
 * Slash command resolution — looks up commands by slash name or alias.
 */

interface SlashCommandResult {
  handled: boolean
  error?: string
}

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

/** Find and execute a slash command from the resolved commands. */
export const executeSlashCommand = (
  cmd: string,
  args: string,
  commands: ReadonlyArray<Command>,
): SlashCommandResult => {
  const match = findSlashCommand(cmd, commands)
  if (Option.isNone(match)) {
    return { handled: false, error: `Unknown command: /${cmd}` }
  }

  const onSlash = Option.fromNullishOr(match.value.onSlash)
  if (Option.isSome(onSlash)) onSlash.value(args)
  else match.value.onSelect()
  return { handled: true }
}

/**
 * Parse slash command from input
 * @returns [command, args] or null if not a slash command
 */
// eslint-disable-next-line effect/noNullish -- parser API uses null as its no-match sentinel.
export function parseSlashCommand(input: string): [string, string] | null {
  const trimmed = input.trim()
  // eslint-disable-next-line effect/noNullish -- parser API uses null as its no-match sentinel.
  if (!trimmed.startsWith("/")) return null

  const spaceIdx = trimmed.indexOf(" ")
  if (spaceIdx === -1) {
    return [trimmed.slice(1), ""]
  }

  return [trimmed.slice(1, spaceIdx), trimmed.slice(spaceIdx + 1).trim()]
}

/**
 * Whether `/name` is a resolved slash command, matched like
 * {@link executeSlashCommand} does.
 *
 * The composer asks this to decide whether completing a slash name should
 * dispatch the command or only insert its text. No command in this repo
 * requires an argument: the arg-aware ones (`/model`, `/think`, `/goal`,
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
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** A structural level in the palette stack.
 *
 *  `source` is a Solid accessor — can be a plain function for sync levels
 *  or a `Resource` for async levels. Returns `undefined` while loading. */
interface PaletteLevel {
  readonly id: string
  readonly title: string
  // eslint-disable-next-line effect/noNullish -- Solid Resource returns undefined while its request is pending.
  readonly source: Accessor<readonly PaletteItem[] | undefined>
  readonly onEnter?: () => void
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

const PaletteSourceSchema = Schema.declare<PaletteLevel["source"]>(
  (value): value is PaletteLevel["source"] => Predicate.isFunction(value),
)
const PaletteOnEnterSchema = Schema.declare<() => void>((value): value is () => void =>
  Predicate.isFunction(value),
)
const PaletteLevelSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: PaletteSourceSchema,
  onEnter: Schema.optionalKey(PaletteOnEnterSchema),
})

const CommandPaletteEvent = Schema.TaggedUnion({
  Open: { rootLevel: PaletteLevelSchema },
  Close: {},
  PushLevel: { level: PaletteLevelSchema },
  PopLevel: {},
  SelectCategory: { category: Schema.String },
})
type CommandPaletteEvent = Schema.Schema.Type<typeof CommandPaletteEvent>

const initial = (): CommandPaletteState => ({
  levelStack: [],
  category: "",
})

const currentLevel = (state: CommandPaletteState): Option.Option<PaletteLevel> =>
  Array.last(state.levelStack)

const pushLevel = (state: CommandPaletteState, level: PaletteLevel): CommandPaletteState => ({
  levelStack: [...state.levelStack, level],
  category: "",
})

const popLevel = (state: CommandPaletteState): CommandPaletteState => {
  if (state.levelStack.length <= 1) return state
  return {
    levelStack: state.levelStack.slice(0, -1),
    category: "",
  }
}

const CommandPaletteState = {
  initial,
  currentLevel,
}

function transitionCommandPalette(
  state: CommandPaletteState,
  event: CommandPaletteEvent,
): CommandPaletteState {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      Open: (event) => ({ ...initial(), levelStack: [event.rootLevel] }),
      Close: () => initial(),
      PushLevel: (event) => pushLevel(state, event.level),
      PopLevel: () => popLevel(state),
      SelectCategory: (event) => ({ ...state, category: event.category }),
    }),
  )
}

// ── command palette ─────────────────────────────────────────────────────────

const filterItems = (items: readonly PaletteItem[], query: string): readonly PaletteItem[] => {
  if (query.length === 0) return items
  return matchSorter(items, query, {
    keys: ["title", "description", "category"],
  })
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
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(CommandPaletteState.initial())
  // The list owns the query and the cursor; the palette keeps a copy of the
  // query to filter with and a handle to reset the list when a level changes.
  const [searchQuery, setSearchQuery] = createSignal("")
  let list = Option.none<SelectListApi>()
  const resetList = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.reset() })
  const listToTop = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.moveTo(0) })

  const dispatch = (event: Parameters<typeof transitionCommandPalette>[1]) => {
    setState((current) => transitionCommandPalette(current, event))
  }

  const closePalette = () => {
    dispatch(CommandPaletteEvent.cases.Close.make({}))
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
    source: (): readonly PaletteItem[] => {
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
      return [
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
      ]
    },
  })

  // Dark/Light is the variant every theme resolves in, so it is its own level
  // rather than three entries mixed into the theme list.
  const modeLevel = (): PaletteLevel => ({
    id: "mode",
    title: "Mode",
    source: (): readonly PaletteItem[] => {
      const current = mode()
      const item = (value: "dark" | "light", title: string): PaletteItem => ({
        id: `mode.${value}`,
        title: selectedTitle(title, current === value),
        onSelect: () => {
          setMode(value)
          closePalette()
        },
      })
      return [item("dark", "Dark"), item("light", "Light")]
    },
  })

  const branchesLevel = (): PaletteLevel => {
    const [branches] = createResource(() => client.runtime.run(client.listBranches))
    return {
      id: "branches",
      title: "Branches",
      source: () =>
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(branches()), (items) =>
            items.map((branch) => ({
              id: `branch.${branch.id}`,
              title: selectedTitle(
                branch.name ?? `Branch ${shortId(branch.id)}`,
                client.session()?.branchId === branch.id,
              ),
              onSelect: () => {
                if (client.session()?.branchId !== branch.id) client.switchBranch(branch.id)
                closePalette()
              },
            })),
          ),
        ),
    }
  }

  const pushLevel = (level: PaletteLevel) => {
    dispatch(CommandPaletteEvent.cases.PushLevel.make({ level }))
    resetList()
    level.onEnter?.()
  }

  const rootLevel = (): PaletteLevel => ({
    id: "root",
    title: "Commands",
    source: (): readonly PaletteItem[] => [
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
        onSelect: () => {
          cmd.onSelect()
          closePalette()
        },
      })),
    ],
  })

  // ── Derived state ──

  const currentLevel = () => CommandPaletteState.currentLevel(state())

  /** `None` while the level's request is pending. */
  const levelSource = createMemo(() =>
    Option.flatMap(currentLevel(), (level) => Option.fromNullishOr(level.source())),
  )
  const loading = () => Option.isNone(levelSource())
  const levelItems = createMemo<readonly PaletteItem[]>(() =>
    Option.getOrElse(levelSource(), (): readonly PaletteItem[] => []),
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
    dispatch(CommandPaletteEvent.cases.PopLevel.make({}))
    resetList()
  }

  const handleSelect = (item: PaletteItem) => {
    if (item.disabled === true) return
    item.onSelect()
  }

  const cycleCategory = (backward: boolean) => {
    const items = categories()
    let step = 1
    if (backward) step = -1
    const index = (items.indexOf(category()) + step + items.length) % items.length
    dispatch(
      CommandPaletteEvent.cases.SelectCategory.make({
        category: Option.getOrElse(Option.fromNullishOr(items[index]), () => ""),
      }),
    )
    listToTop()
  }

  // Escape clears a query before it leaves a level, and backspace on an empty
  // query walks back a level. Both are the list's keys otherwise, so the pane
  // claims them only in those cases.
  const escapeLevel = () => {
    if (searchQuery().length > 0) {
      resetList()
      return
    }
    popLevel()
  }

  createEffect(() => {
    if (command.paletteOpen()) {
      dispatch(CommandPaletteEvent.cases.Open.make({ rootLevel: rootLevel() }))
    }
  })

  const hasDetails = () =>
    filteredItems().some((item) => Boolean(item.description?.trim() || item.shortcut))
  const labelWidth = () => {
    if (!hasDetails()) return dimensions().width
    return Math.max(8, Math.min(24, Math.floor(dimensions().width * 0.28)))
  }

  const footerHint = () => {
    let close = "Close"
    if (state().levelStack.length > 1) close = "Back"
    if (dimensions().width < 56) return `↑↓ Move · Tab Group · ↵ Open · Esc ${close}`
    return `↑↓ Navigate     Tab Category     Enter Open     Esc ${close}`
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
        const disabled = item.disabled === true
        const itemTextColor = () => {
          if (disabled) return theme.textMuted
          if (isSelected()) return theme.primary
          return theme.text
        }
        const metaColor = () => {
          if (disabled) return theme.textMuted
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
              <span style={{ bold: isSelected() && !disabled }}>
                {truncate(item.title, labelWidth() - 2)}
              </span>
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

  const emptyRow = () => {
    let label = "No matches"
    if (loading()) label = "Loading…"
    return (
      <box paddingLeft={1}>
        <text style={{ fg: theme.textMuted }}>{label}</text>
      </box>
    )
  }

  return (
    <Show when={command.paletteOpen()}>
      <PickerFrame
        lines={filteredItems().length}
        queryRow
        title={paletteTitle()}
        footer={footerHint()}
      >
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
          empty={emptyRow}
          api={(api) => (list = Option.some(api))}
          extraKeys={(event, selected) => {
            if (event.name === "tab") {
              cycleCategory(event.shift === true)
              return true
            }
            if (event.name === "escape") {
              escapeLevel()
              return true
            }
            if (event.name === "left") {
              popLevel()
              return true
            }
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
          onDismiss={escapeLevel}
        />
      </PickerFrame>
    </Show>
  )
}
