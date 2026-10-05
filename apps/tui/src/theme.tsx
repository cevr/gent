import { RGBA, SyntaxStyle, type TerminalColors } from "@opentui/core"
import { Config, Effect, Fiber, Option, Predicate, Record, Schema, Struct } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GentPlatform } from "@gent/core/host"
import {
  createContext,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
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

/**
 * The tokens a theme JSON names, each one a color gent draws: opencode's
 * names, cut to the ones with a consumer (the roles are in `apps/tui/AGENTS.md`).
 * `selectedListItemText` and `backgroundPanel` may be left out: resolution
 * supplies both.
 */
const JSON_TOKENS = [
  "primary",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "border",
  "diffAdded",
  "diffRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownListItem",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const
type JsonToken = (typeof JSON_TOKENS)[number]

/** The resolved theme: every token as a color. */
export type Theme = Record<JsonToken | "selectedListItemText" | "backgroundPanel", RGBA>

/**
 * The tokens `UserRow` draws on `backgroundPanel`: the prompt, its muted
 * header and an image line. Each reads at `MIN_TEXT_CONTRAST` there.
 */
export const PANEL_TEXT_TOKENS = ["text", "textMuted", "info"] as const satisfies ReadonlyArray<
  keyof Theme
>

/**
 * The tokens drawn as text on the background: each reads at
 * `MIN_TEXT_CONTRAST` there. The `system` theme is clamped to this rule at
 * runtime; the bundled themes hold it in their JSON (`theme.test.tsx`).
 */
export const TEXT_TOKENS = [
  "text",
  "textMuted",
  "primary",
  "info",
  "success",
  "warning",
  "error",
  "diffAdded",
  "diffRemoved",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownListItem",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const satisfies ReadonlyArray<keyof Theme>

/** A theme color an extension names; the host draws it in the active theme. */
export const NamedThemeColor = Schema.Literals([
  "warning",
  "error",
  "info",
  "success",
  "primary",
  "text",
  "textMuted",
])
export type NamedThemeColor = Schema.Schema.Type<typeof NamedThemeColor>

/** A named theme color or a resolved one, as the active theme draws it. */
export const resolveThemeColor = (theme: Theme, color: RGBA | NamedThemeColor): RGBA => {
  if (Predicate.isString(color)) return theme[color]
  return color
}

/** What `detectColorScheme` reads off the terminal. */
type ThemeMode = "dark" | "light"

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA

/**
 * opencode's theme schema. A key gent does not draw (an opencode theme's
 * `backgroundElement`, `thinkingOpacity`, …) is ignored, so an opencode
 * theme file resolves as it is.
 */
interface ThemeJson {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Record<JsonToken, ColorValue> & {
    selectedListItemText?: ColorValue
    backgroundPanel?: ColorValue
  }
}

// ── contrast ────────────────────────────────────────────────────────────────

/** WCAG 2.1 minimums: text on its background, and a glyph or rule (1.4.11). */
export const MIN_TEXT_CONTRAST = 4.5
export const MIN_GLYPH_CONTRAST = 3
/** How far `text` stands from `textMuted`: the answer reads apart from what gent draws around it. */
export const MIN_MUTED_STEP = 1.5

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)
const BLACK = RGBA.fromInts(0, 0, 0)
const WHITE = RGBA.fromInts(255, 255, 255)

const relativeLuminance = (color: RGBA): number => {
  const linear = (channel: number) => {
    if (channel <= 0.04045) return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** The WCAG contrast ratio of two opaque colors, 1 to 21. */
export const contrastRatio = (a: RGBA, b: RGBA): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Codex's `is_light`: the background's perceived brightness is over half. */
const isLight = (color: RGBA): boolean =>
  (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) * 255 > 128

/** Black or white, whichever stands further from `background`. */
const farEndpoint = (background: RGBA): RGBA => {
  if (contrastRatio(BLACK, background) >= contrastRatio(WHITE, background)) return BLACK
  return WHITE
}

/** The first of 255 steps from `from` to `to` that `passes`, else `to`. */
const firstStep = (from: RGBA, to: RGBA, passes: (candidate: RGBA) => boolean): RGBA => {
  for (let step = 1; step <= 255; step++) {
    const candidate = tint(from, to, step / 255)
    if (passes(candidate)) return candidate
  }
  return to
}

/**
 * `color`, moved toward black or white by the smallest step that reads at
 * `min` on `background`: Codex's bounded search (`style/contrast.rs`
 * `foreground`), which keeps as much of the hue as the surface allows.
 */
const readableOn = (color: RGBA, background: RGBA, min = MIN_TEXT_CONTRAST): RGBA => {
  if (contrastRatio(color, background) >= min) return color
  return firstStep(color, farEndpoint(background), (step) => contrastRatio(step, background) >= min)
}

/** The answer's color and the muted color around it. */
interface TextPair {
  readonly text: RGBA
  readonly muted: RGBA
}

/**
 * `text` and `muted` kept `MIN_MUTED_STEP` apart: `muted` moves toward the
 * background while it stays readable there, then `text` moves away from it.
 */
const readableStep = (text: RGBA, muted: RGBA, background: RGBA): TextPair => {
  if (contrastRatio(text, muted) >= MIN_MUTED_STEP) return { text, muted }
  let dimmer = muted
  for (let step = 1; step <= 255; step++) {
    const candidate = tint(muted, background, step / 255)
    if (contrastRatio(candidate, background) < MIN_TEXT_CONTRAST) break
    dimmer = candidate
    if (contrastRatio(text, dimmer) >= MIN_MUTED_STEP) return { text, muted: dimmer }
  }
  const settled = dimmer
  const brighter = firstStep(
    text,
    farEndpoint(background),
    (step) => contrastRatio(step, settled) >= MIN_MUTED_STEP,
  )
  return { text: brighter, muted: settled }
}

/** Codex's prompt fill (`user_message_bg_rgb`): white at 12% on a dark background, black at 4% on a light one. */
const promptFill = (background: RGBA): RGBA => {
  if (isLight(background)) return tint(background, BLACK, 0.04)
  return tint(background, WHITE, 0.12)
}

/**
 * `panel`, moved toward `background` by the smallest step on which every
 * ink reads at `MIN_TEXT_CONTRAST`. The inks read on the background itself
 * (the catalog rule), so the search ends there at worst: the fill only
 * fades, it never trades the text's contrast for its own mark.
 */
const readablePanel = (panel: RGBA, background: RGBA, inks: ReadonlyArray<RGBA>): RGBA => {
  const everyReads = (candidate: RGBA) =>
    inks.every((ink) => contrastRatio(ink, candidate) >= MIN_TEXT_CONTRAST)
  if (everyReads(panel)) return panel
  return firstStep(panel, background, everyReads)
}

// ── theme resolution ────────────────────────────────────────────────────────

/**
 * Resolve a theme JSON to concrete RGBA values for a given mode.
 *
 * `terminalBackground` is the terminal's own background, when it reported
 * one: a theme whose `background` is transparent draws on it, so the
 * derived `backgroundPanel` is made from it. With neither, the panel is
 * transparent: no fill.
 */
export function resolveTheme(
  theme: ThemeJson,
  mode: "dark" | "light",
  terminalBackground: Option.Option<RGBA> = Option.none(),
): Theme {
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

  const resolved = Record.map(Struct.pick(theme.theme, JSON_TOKENS), resolveColor)
  const optional = (token: "selectedListItemText" | "backgroundPanel") =>
    Option.map(Option.fromNullishOr(theme.theme[token]), resolveColor)
  const surface = Option.orElse(
    Option.filter(Option.some(resolved.background), (background) => background.a > 0),
    () => terminalBackground,
  )
  const inks = PANEL_TEXT_TOKENS.map((token) => resolved[token])
  // The theme's own panel, else Codex's fill on the surface; either fades
  // toward the surface until the panel's inks read. A transparent panel is
  // the derived one; with no surface known there is no fill to judge.
  const named = Option.filter(optional("backgroundPanel"), (panel) => panel.a > 0)
  return {
    ...resolved,
    selectedListItemText: Option.getOrElse(
      optional("selectedListItemText"),
      () => resolved.background,
    ),
    backgroundPanel: Option.match(surface, {
      onNone: () => Option.getOrElse(named, () => TRANSPARENT),
      onSome: (background) =>
        readablePanel(
          Option.getOrElse(named, () => promptFill(background)),
          background,
          inks,
        ),
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
    theme: readableSystemColors({
      primary: ansiColors.cyan,
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,
      text: fg,
      textMuted,
      selectedListItemText: bg,
      background: bg,
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
    }),
  }
}

/** The terminal palette's colors, before the panel is derived from the background. */
type SystemColors = Omit<Theme, "backgroundPanel">

/**
 * A terminal's palette made readable on its own background: a terminal can
 * report any colors, so text, the border, the muted step and the selected
 * row are each clamped (`readableOn`), as Codex clamps the colors it draws.
 */
const readableSystemColors = (colors: SystemColors): SystemColors => {
  const background = colors.background
  const text = Record.map(Struct.pick(colors, TEXT_TOKENS), (color) =>
    readableOn(color, background),
  )
  const step = readableStep(text.text, text.textMuted, background)
  return {
    ...colors,
    ...text,
    text: step.text,
    textMuted: step.muted,
    border: readableOn(colors.border, background, MIN_GLYPH_CONTRAST),
    selectedListItemText: readableOn(colors.selectedListItemText, text.primary),
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

const readColorFgBg = Config.option(Config.String("COLORFGBG")).pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
)

const readDarwinAppearance = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("defaults", ["read", "-g", "AppleInterfaceStyle"], {
        forceKillAfter: "2 seconds",
      }),
    )
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
  /**
   * The terminal's palette read has ended, answered or not. Native history
   * waits for it, so a row reaches scrollback with the fill it keeps.
   */
  paletteSettled: () => boolean
  selected: () => string
  all: () => Record<string, ThemeJson>
  mode: () => "dark" | "light"
  setMode: (mode: "dark" | "light") => void
  set: (theme: string) => void
}

const ThemeContext = createContext<ThemeContextValue>()

/** The provider's own state: the mode and the theme picked by name. */
interface ThemeStore {
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

export function ThemeProvider(props: ThemeProviderProps) {
  const renderer = useRenderer()

  // Mode is resolved by the host (main.tsx) before render so theme detection
  // never runs in the synchronous render path. A render that names none (a
  // test of <App />) draws dark.
  const [store, setStore] = createStore<ThemeStore>({
    mode: Option.getOrElse(Option.fromNullishOr(props.mode), (): ThemeMode => "dark"),
    active: "fx",
  })

  // The terminal's palette, once read. The `system` theme is drawn from it
  // for the mode in force, so a mode switch redraws it.
  const [systemColors, setSystemColors] = createSignal(Option.none<TerminalColors>())
  // The terminal's own background, once it answers: a transparent theme
  // draws on it, so `backgroundPanel` is derived from it.
  const [terminalBackground, setTerminalBackground] = createSignal(Option.none<RGBA>())
  const [paletteSettled, setPaletteSettled] = createSignal(false)
  const themes = createMemo((): Record<string, ThemeJson> =>
    Option.match(systemColors(), {
      onNone: () => DEFAULT_THEMES,
      onSome: (colors) => ({ ...DEFAULT_THEMES, system: generateSystemTheme(colors, store.mode) }),
    }),
  )

  onMount(() => resolveSystemTheme())

  // One palette read at a time: a new read (SIGUSR2) replaces the one in
  // flight, and unmount stops it, so a late reply never writes the store.
  let paletteRead = Option.none<Fiber.Fiber<void>>()
  const stopPaletteRead = () => {
    if (Option.isSome(paletteRead)) Effect.runFork(Fiber.interrupt(paletteRead.value))
    paletteRead = Option.none()
  }
  onCleanup(stopPaletteRead)

  const keepDefault = () => {
    if (store.active === "system") setStore("active", "fx")
  }

  function resolveSystemTheme() {
    stopPaletteRead()
    paletteRead = Option.some(
      Effect.runFork(
        Effect.tryPromise(() => renderer.getPalette({ size: 16 })).pipe(
          Effect.match({
            // Keep the default when palette detection fails.
            onFailure: keepDefault,
            onSuccess: (colors) => {
              setTerminalBackground(
                Option.map(
                  Option.filter(
                    Option.fromNullishOr(colors.defaultBackground),
                    (hex) => hex.length > 0,
                  ),
                  (hex) => RGBA.fromHex(hex),
                ),
              )
              // Keep the default when the terminal does not report its palette.
              if (Option.isNone(Option.fromNullishOr(colors.palette[0]))) return keepDefault()
              setSystemColors(Option.some(colors))
            },
          }),
          Effect.andThen(
            Effect.sync(() => {
              setPaletteSettled(true)
            }),
          ),
        ),
      ),
    )
  }

  // Listen for SIGUSR2 to refresh palette
  const sigusr2Handler = () => {
    renderer.clearPaletteCache()
    resolveSystemTheme()
  }
  process.on("SIGUSR2", sigusr2Handler)
  onCleanup(() => process.off("SIGUSR2", sigusr2Handler))

  const values = createMemo(() => {
    const activeTheme = Option.getOrElse(
      Option.orElse(Option.fromNullishOr(themes()[store.active]), () =>
        Option.fromNullishOr(themes()["fx"]),
      ),
      () => DEFAULT_THEMES.fx,
    )
    return resolveTheme(activeTheme, store.mode, terminalBackground())
  })

  const theme = lazyView(values)

  const value: ThemeContextValue = {
    theme,
    paletteSettled,
    selected: () => store.active,
    all: themes,
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
