import { RGBA, SyntaxStyle, type TerminalColors } from "@opentui/core"
import { Config, Effect, Option, Predicate, Record } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GentPlatform } from "@gent/core/host"
import { createContext, createMemo, type JSX, onCleanup, onMount, untrack } from "solid-js"
import { useRequiredContext } from "./utils"
import { createStore } from "solid-js/store"
import { useRenderer } from "@opentui/solid"
import catppuccin from "./themes/catppuccin.json" with { type: "json" }
import dracula from "./themes/dracula.json" with { type: "json" }
import fx from "./themes/fx.json" with { type: "json" }
import gruvbox from "./themes/gruvbox.json" with { type: "json" }
import nord from "./themes/nord.json" with { type: "json" }
import opencode from "./themes/opencode.json" with { type: "json" }
import tokyonight from "./themes/tokyonight.json" with { type: "json" }

// ── theme types ─────────────────────────────────────────────────────────────

// Core color palette for the application theme
interface ThemeColors {
  primary: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownListItem: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

export type Theme = ThemeColors

type ThemeMode = "dark" | "light" | "system"

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA

interface ThemeJson {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Omit<Record<keyof ThemeColors, ColorValue>, "selectedListItemText" | "backgroundMenu"> & {
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
  }
}

// ── theme resolution ────────────────────────────────────────────────────────

/**
 * Resolve a theme JSON to concrete RGBA values for a given mode
 */
export function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const defs = theme.defs ?? {}
  const themeColors = new Map(Object.entries(theme.theme))

  function resolveColor(c: ColorValue | number): RGBA {
    if (c instanceof RGBA) return c
    if (Predicate.isString(c)) {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (c.startsWith("#")) return RGBA.fromHex(c)
      const definition = Record.get(defs, c)
      if (Option.isSome(definition)) {
        return resolveColor(definition.value)
      }
      const themeColor = Option.fromNullishOr(themeColors.get(c))
      if (Option.isSome(themeColor)) {
        return resolveColor(themeColor.value)
      }
      return Effect.runSync(
        Effect.die(new Error(`Color reference "${c}" not found in defs or theme`)),
      )
    }
    if (Predicate.isNumber(c)) {
      return ansiToRgba(c)
    }
    return resolveColor(c[mode])
  }

  const { selectedListItemText, backgroundMenu, ...colors } = theme.theme
  const resolved = Record.map(colors, resolveColor)
  const selectedText = Option.fromNullishOr(selectedListItemText)
  return {
    ...resolved,
    selectedListItemText: Option.match(selectedText, {
      onNone: () => resolved.background,
      onSome: resolveColor,
    }),
    backgroundMenu: Option.match(Option.fromNullishOr(backgroundMenu), {
      onNone: () => resolved.backgroundElement,
      onSome: resolveColor,
    }),
  }
}

/**
 * Convert ANSI color code to RGBA
 */
function ansiToRgba(code: number): RGBA {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x: number) => {
      if (x === 0) return 0
      return x * 40 + 55
    }
    return RGBA.fromInts(val(r), val(g), val(b))
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  return RGBA.fromInts(0, 0, 0)
}

/**
 * Tint a base color with an overlay color
 */
function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

/**
 * Generate a theme from terminal colors (system theme)
 */
function generateSystemTheme(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0] ?? "#000000")
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7] ?? "#ffffff")
  const isDark = mode === "dark"

  const col = (i: number) => {
    const value = Option.fromNullishOr(colors.palette[i])
    if (Option.isSome(value) && value.value.length > 0) return RGBA.fromHex(value.value)
    return ansiToRgba(i)
  }

  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)

  // Helper to get gray with fallback
  const gray = (i: number) => grays[i] ?? bg

  const ansiColors = {
    black: col(0),
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    white: col(7),
    redBright: col(9),
    greenBright: col(10),
  }

  let diffAlpha = 0.14
  if (isDark) diffAlpha = 0.22
  const diffAddedBg = tint(bg, ansiColors.green, diffAlpha)
  const diffRemovedBg = tint(bg, ansiColors.red, diffAlpha)
  const diffAddedLineNumberBg = tint(gray(3), ansiColors.green, diffAlpha)
  const diffRemovedLineNumberBg = tint(gray(3), ansiColors.red, diffAlpha)

  return {
    theme: {
      primary: ansiColors.cyan,
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,
      text: fg,
      textMuted,
      selectedListItemText: bg,
      background: bg,
      backgroundElement: gray(3),
      backgroundMenu: gray(3),
      borderSubtle: gray(6),
      border: gray(7),
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg: gray(1),
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownListItem: ansiColors.blue,
      syntaxComment: textMuted,
      syntaxKeyword: ansiColors.magenta,
      syntaxFunction: ansiColors.blue,
      syntaxVariable: fg,
      syntaxString: ansiColors.green,
      syntaxNumber: ansiColors.yellow,
      syntaxType: ansiColors.cyan,
      syntaxOperator: ansiColors.cyan,
      syntaxPunctuation: fg,
    },
  }
}

type GrayScale = Record<number, RGBA>

function generateGrayScale(bg: RGBA, isDark: boolean): GrayScale {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0
    let newR: number, newG: number, newB: number

    if (isDark) {
      if (luminance < 10) {
        const grayValue = Math.floor(factor * 0.4 * 255)
        newR = newG = newB = grayValue
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4
        const ratio = newLum / luminance
        newR = Math.min(bgR * ratio, 255)
        newG = Math.min(bgG * ratio, 255)
        newB = Math.min(bgB * ratio, 255)
      }
    } else {
      if (luminance > 245) {
        const grayValue = Math.floor(255 - factor * 0.4 * 255)
        newR = newG = newB = grayValue
      } else {
        const newLum = luminance * (1 - factor * 0.4)
        const ratio = newLum / luminance
        newR = Math.max(bgR * ratio, 0)
        newG = Math.max(bgG * ratio, 0)
        newB = Math.max(bgB * ratio, 0)
      }
    }

    grays[i] = RGBA.fromInts(Math.floor(newR), Math.floor(newG), Math.floor(newB))
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  let grayValue: number
  if (isDark) {
    grayValue = 180
    if (bgLum >= 10) grayValue = Math.min(Math.floor(160 + bgLum * 0.3), 200)
  } else {
    grayValue = 75
    if (bgLum <= 245) grayValue = Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60)
  }

  return RGBA.fromInts(grayValue, grayValue, grayValue)
}

// ── syntax highlighting ─────────────────────────────────────────────────────

export function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    {
      scope: ["comment", "comment.documentation"],
      style: { foreground: theme.syntaxComment, italic: true },
    },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.function", "function.method"], style: { foreground: theme.syntaxFunction } },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true, italic: true } },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: { foreground: theme.syntaxOperator },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: { foreground: theme.syntaxVariable },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: { foreground: theme.syntaxFunction },
    },
    { scope: ["type", "module", "class"], style: { foreground: theme.syntaxType } },
    { scope: ["constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["property", "parameter"], style: { foreground: theme.syntaxVariable } },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: { foreground: theme.syntaxPunctuation },
    },
    // Markdown-specific
    {
      scope: [
        "markup.heading",
        "markup.heading.1",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
      ],
      style: { foreground: theme.markdownHeading, bold: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: theme.markdownStrong, bold: true },
    },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
    {
      scope: ["markup.raw.inline"],
      style: { foreground: theme.markdownCode, background: theme.background },
    },
    {
      scope: ["markup.link", "markup.link.url"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    {
      scope: ["markup.link.label"],
      style: { foreground: theme.markdownLinkText, underline: true },
    },
    { scope: ["conceal"], style: { foreground: theme.textMuted } },
    { scope: ["spell", "nospell"], style: { foreground: theme.text } },
  ])
}

// ── terminal color scheme detection ─────────────────────────────────────────

const readColorFgBg = Config.option(Config.string("COLORFGBG")).pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
)

const readDarwinAppearance = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner
    .exitCode(ChildProcess.make("defaults", ["read", "-g", "AppleInterfaceStyle"]))
    .pipe(Effect.orElseSucceed(() => 1))
  if (exitCode === 0) return "dark"
  return "light"
})

/**
 * Detect if terminal is using dark or light mode.
 * Strategies in order:
 * 1. COLORFGBG env var (set by some terminals)
 * 2. macOS system appearance (`defaults read AppleInterfaceStyle`)
 * 3. Default to dark
 */
export const detectColorScheme: Effect.Effect<
  "dark" | "light",
  never,
  ChildProcessSpawner.ChildProcessSpawner | GentPlatform
> = Effect.gen(function* () {
  const colorFgBg = yield* readColorFgBg
  if (Option.isSome(colorFgBg) && colorFgBg.value.length > 0) {
    const parts = colorFgBg.value.split(";")
    const bg = parseInt(
      Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => "0"),
      10,
    )
    // ANSI colors 0-6 are typically dark, 7+ are light
    if (bg > 6) return "light"
    return "dark"
  }

  const platform = yield* GentPlatform
  const info = yield* platform.osInfo
  if (info.platform === "darwin") return yield* readDarwinAppearance

  return "dark"
})

// ── bundled themes ──────────────────────────────────────────────────────────

export const DEFAULT_THEMES = {
  fx,
  opencode,
  catppuccin,
  dracula,
  nord,
  gruvbox,
  tokyonight,
} satisfies Record<string, ThemeJson>

// ── theme provider ──────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: Theme
  selected: () => string
  all: () => Record<string, ThemeJson>
  mode: () => "dark" | "light"
  setMode: (mode: "dark" | "light") => void
  set: (theme: string) => void
}

const ThemeContext = createContext<ThemeContextValue>()

/**
 * The provider's own state. `themes` stays an open dictionary because the
 * terminal-derived `system` theme is added at runtime, alongside the shipped
 * catalogue.
 */
interface ThemeStore {
  themes: Record<string, ThemeJson>
  mode: "dark" | "light"
  active: string
}

export function useTheme(): ThemeContextValue {
  return useRequiredContext(ThemeContext, "useTheme must be used within ThemeProvider")
}

interface ThemeProviderProps {
  mode?: ThemeMode
  children: JSX.Element
}

/**
 * One stable object whose every property reads through `source()` on access.
 * The keys come from the source itself, so a new Theme key is never a silent
 * runtime hole; the object identity never changes, so consumers hold one ref.
 */
const lazyView = <A extends object>(source: () => A): A => {
  const view: A = { ...untrack(source) }
  for (const key in view) {
    Object.defineProperty(view, key, { get: () => source()[key], enumerable: true })
  }
  return view
}

export const createThemeView = (values: () => Theme): Theme => lazyView(values)

export function ThemeProvider(props: ThemeProviderProps) {
  const renderer = useRenderer()

  // Mode is resolved by the host (main.tsx) before render so theme detection
  // never runs in the synchronous render path. Fall back to "dark" if absent
  // (e.g. debug harnesses that don't set it).
  const initialMode = (): "dark" | "light" => {
    if (props.mode === "dark" || props.mode === "light") return props.mode
    return "dark"
  }

  const [store, setStore] = createStore<ThemeStore>({
    themes: { ...DEFAULT_THEMES },
    mode: initialMode(),
    active: "fx",
  })

  function init() {
    resolveSystemTheme()
  }

  onMount(init)

  function resolveSystemTheme() {
    renderer
      .getPalette({ size: 16 })
      .then((colors) => {
        const firstColor = Option.fromNullishOr(colors.palette[0])
        if (Option.isNone(firstColor)) {
          // Keep the default when the terminal does not report its palette.
          if (store.active === "system") setStore("active", "fx")
          return
        }
        setStore("themes", "system", generateSystemTheme(colors, store.mode))
      })
      .catch(() => {
        // Keep the default when palette detection fails.
        if (store.active === "system") setStore("active", "fx")
      })
  }

  // Listen for SIGUSR2 to refresh palette
  const sigusr2Handler = () => {
    renderer.clearPaletteCache()
    init()
  }
  process.on("SIGUSR2", sigusr2Handler)
  onCleanup(() => process.off("SIGUSR2", sigusr2Handler))

  const values = createMemo(() => {
    const activeTheme = Option.getOrElse(
      Option.orElse(Option.fromNullishOr(store.themes[store.active]), () =>
        Option.fromNullishOr(store.themes["fx"]),
      ),
      () => DEFAULT_THEMES.fx,
    )
    return resolveTheme(activeTheme, store.mode)
  })

  const theme = createThemeView(values)

  const value: ThemeContextValue = {
    theme,
    selected: () => store.active,
    all: () => store.themes,
    mode: () => store.mode,
    setMode: (mode: "dark" | "light") => {
      setStore("mode", mode)
    },
    set: (theme: string) => {
      setStore("active", theme)
    },
  }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}
