/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { createEffect } from "solid-js"
import {
  contrastRatio,
  DEFAULT_THEMES,
  MIN_GLYPH_CONTRAST,
  MIN_MUTED_STEP,
  MIN_TEXT_CONTRAST,
  PANEL_TEXT_TOKENS,
  resolveTheme,
  TEXT_TOKENS,
  type Theme,
  useTheme,
} from "../src/theme"
import { Effect, Option } from "effect"
import { RGBA, rgbToHex, type TerminalColors } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { CommandPalette, useCommand } from "../src/commands"
import { answerPalette, renderFrame, renderScoped } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"

// ── theme view ──────────────────────────────────────────────────────────────

const dark = resolveTheme(DEFAULT_THEMES.fx, "dark")
const light = resolveTheme(DEFAULT_THEMES.fx, "light")

const keysOf = (theme: Theme) => Object.keys(theme).sort()

/** Reads every enumerable getter on the view and checks each against the resolved theme. */
const expectViewToMirror = (view: Theme, theme: Theme) => {
  const expected = new Map(Object.entries(theme))
  const seen = Object.entries(view)
  expect(seen.length).toBe(expected.size)
  for (const [key, color] of seen) {
    expect(expected.has(key)).toBe(true)
    expect(expected.get(key)).toEqual(color)
  }
}

describe("theme view", () => {
  // The provider hands out one theme object; each key reads the theme in force.
  it.scopedLive(
    "every theme key is a getter on one object, and a mode switch shows through it",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ReturnType<typeof useTheme>>()
        const Probe = () => {
          ctx = Option.some(useTheme())
          return <text>probe</text>
        }
        yield* renderScoped(() => <Probe />)
        const context = yield* Effect.fromOption(ctx)
        context.set("fx")
        context.setMode("dark")
        const view = context.theme
        expect(keysOf(view)).toEqual(keysOf(dark))
        for (const key of Object.keys(view)) {
          const descriptor = Object.getOwnPropertyDescriptor(view, key)
          expect(descriptor).toBeDefined()
          // A data-property descriptor carries no `get` key at all.
          expect("get" in descriptor!).toBe(true)
          expect(descriptor!.enumerable).toBe(true)
        }
        expectViewToMirror(view, dark)
        expect(dark.background).not.toBe(light.background)
        context.setMode("light")
        expect(context.theme).toBe(view)
        expectViewToMirror(view, light)
      }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── system theme ────────────────────────────────────────────────────────────

/** What a terminal answers to the palette query: a 16-color gray ramp and its own fg/bg. */
const terminalColors = (foreground: string, background: string): TerminalColors => ({
  palette: Array.from(
    { length: 16 },
    (_, i) => `#${(i * 16).toString(16).padStart(2, "0").repeat(3)}`,
  ),
  defaultForeground: foreground,
  defaultBackground: background,
  cursorColor: "#000000",
  mouseForeground: "#000000",
  mouseBackground: "#000000",
  tekForeground: "#000000",
  tekBackground: "#000000",
  highlightBackground: "#000000",
  highlightForeground: "#000000",
})

/** The answer of a terminal that reports its palette but not its background. */
const withoutBackground = (colors: TerminalColors): TerminalColors => ({
  ...colors,
  // eslint-disable-next-line effect/noNullish -- OpenTUI's palette answer holds null for a color the terminal did not report.
  defaultBackground: null,
})

/** A themed render whose terminal answers `colors`, once the palette read has landed. */
const renderWithPalette = (colors: TerminalColors) =>
  Effect.gen(function* () {
    let ctx = Option.none<ReturnType<typeof useTheme>>()
    const Probe = () => {
      const renderer = useRenderer()
      answerPalette(renderer, colors)
      ctx = Option.some(useTheme())
      return <text>probe</text>
    }
    const setup = yield* renderScoped(() => <Probe />)
    const theme = yield* Effect.fromOption(ctx)
    // The palette read on SIGUSR2 is the one a terminal with this palette answers.
    process.emit("SIGUSR2")
    yield* waitForFrame(setup, () => "system" in theme.all(), "the system theme")
    return { setup, theme }
  })

/** The terminal answers `colors` to a later palette read (SIGUSR2); the mode once it lands. */
const rereadPalette = (
  setup: Effect.Success<ReturnType<typeof renderWithPalette>>["setup"],
  theme: ReturnType<typeof useTheme>,
  colors: TerminalColors,
) =>
  Effect.gen(function* () {
    const before = theme.all()["system"]
    answerPalette(setup.renderer, colors)
    process.emit("SIGUSR2")
    yield* waitForFrame(setup, () => theme.all()["system"] !== before, "the palette read again")
    return theme.mode()
  })

describe("system theme", () => {
  // The terminal's palette is read once; the theme drawn from it is the one
  // for the mode in force, so a mode switch redraws it for that mode.
  it.scopedLive("the terminal-derived theme follows a mode switch", () =>
    Effect.gen(function* () {
      const { setup, theme } = yield* renderWithPalette(terminalColors("#dddddd", "#202020"))
      theme.set("system")
      theme.setMode("dark")
      const dark = theme.theme.diffContextBg
      theme.setMode("light")
      yield* waitForFrame(setup, () => true)
      expect(theme.theme.diffContextBg).not.toEqual(dark)
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A terminal can report any colors; the theme drawn from them still reads.
  it.scopedLive("the system theme clamps a low-contrast palette", () =>
    Effect.gen(function* () {
      const { theme } = yield* renderWithPalette(terminalColors("#777777", "#5a5a5a"))
      theme.set("system")
      const background = RGBA.fromHex("#5a5a5a")
      expect(theme.theme.background).toEqual(background)
      for (const token of TEXT_TOKENS) {
        expect(contrastRatio(theme.theme[token], background)).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        )
      }
      expect(contrastRatio(theme.theme.text, theme.theme.textMuted)).toBeGreaterThanOrEqual(
        MIN_MUTED_STEP,
      )
      expect(contrastRatio(theme.theme.border, background)).toBeGreaterThanOrEqual(
        MIN_GLYPH_CONTRAST,
      )
      expect(
        contrastRatio(theme.theme.selectedListItemText, theme.theme.primary),
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      for (const token of PANEL_TEXT_TOKENS) {
        expect(
          contrastRatio(theme.theme[token], theme.theme.backgroundPanel),
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      }
    }).pipe(Effect.timeout("10 seconds")),
  )

  // fx draws on the terminal's own background, so its panel is made from the
  // background the terminal reports: Codex's 12% fill (#383a3c on #1d1f21),
  // faded until fx's muted header reads on it at 4.5:1.
  it.scopedLive("the default theme's panel derives from the terminal's background", () =>
    Effect.gen(function* () {
      const { theme } = yield* renderWithPalette(terminalColors("#c5c8c6", "#1d1f21"))
      expect(theme.selected()).toBe("fx")
      expect(rgbToHex(theme.theme.backgroundPanel)).toBe("#343638")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── theme mode ──────────────────────────────────────────────────────────────

describe("theme mode", () => {
  // The first guess (COLORFGBG, then the macOS appearance) reads a Linux or
  // ssh terminal with no COLORFGBG as dark. The background the palette read
  // reports is the terminal's own, so it decides: fx draws its light inks.
  it.scopedLive("a light terminal that the first guess read as dark draws light inks", () =>
    Effect.gen(function* () {
      const { theme } = yield* renderWithPalette(terminalColors("#303030", "#ffffff"))
      const white = RGBA.fromHex("#ffffff")
      expect(theme.mode()).toBe("light")
      for (const token of ["text", "textMuted", "info"] as const) {
        expect(contrastRatio(theme.theme[token], white)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      }
      expect(theme.theme.backgroundPanel.a).toBeGreaterThan(0)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a later read that reports a dark background draws dark inks again", () =>
    Effect.gen(function* () {
      const { setup, theme } = yield* renderWithPalette(terminalColors("#303030", "#ffffff"))
      expect(theme.mode()).toBe("light")
      const mode = yield* rereadPalette(setup, theme, terminalColors("#c5c8c6", "#1d1f21"))
      expect(mode).toBe("dark")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A terminal that answers the palette but not its background leaves the
  // first guess in force, and the reader's toggle stands until the next read.
  it.scopedLive("a palette read with no background keeps the mode in force", () =>
    Effect.gen(function* () {
      const { setup, theme } = yield* renderWithPalette(
        withoutBackground(terminalColors("#303030", "#ffffff")),
      )
      expect(theme.mode()).toBe("dark")
      theme.setMode("light")
      const mode = yield* rereadPalette(
        setup,
        theme,
        withoutBackground(terminalColors("#c5c8c6", "#1d1f21")),
      )
      expect(mode).toBe("light")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── theme picker ────────────────────────────────────────────────────────────

/**
 * The palette's Theme level over the bundled catalog.
 *
 * Every registered theme is selectable, and the Dark/Light variant is its own
 * level: picking a theme must not silently move the mode, and picking a mode
 * must not silently move the theme.
 */

function OpenPaletteOnMount() {
  const command = useCommand()
  createEffect(() => {
    command.handleKeybind({ name: "p", ctrl: true }, [], true)
  })
  return <CommandPalette />
}

/**
 * Every key the app reads off a theme; a hole here renders as a missing color.
 * The `satisfies` makes a new `Theme` key a type error until it is listed.
 */
const THEME_KEY_SET = {
  primary: true,
  error: true,
  warning: true,
  success: true,
  info: true,
  text: true,
  textMuted: true,
  selectedListItemText: true,
  background: true,
  backgroundPanel: true,
  border: true,
  diffAdded: true,
  diffRemoved: true,
  diffAddedBg: true,
  diffRemovedBg: true,
  diffContextBg: true,
  diffAddedLineNumberBg: true,
  diffRemovedLineNumberBg: true,
  markdownHeading: true,
  markdownLink: true,
  markdownLinkText: true,
  markdownCode: true,
  markdownBlockQuote: true,
  markdownEmph: true,
  markdownStrong: true,
  markdownListItem: true,
  syntaxComment: true,
  syntaxKeyword: true,
  syntaxFunction: true,
  syntaxVariable: true,
  syntaxString: true,
  syntaxNumber: true,
  syntaxType: true,
  syntaxOperator: true,
  syntaxPunctuation: true,
} satisfies Record<keyof Theme, true>
const THEME_KEYS = Object.keys(THEME_KEY_SET).filter(
  (key): key is keyof Theme => key in THEME_KEY_SET,
)

const MODES: ReadonlyArray<"dark" | "light"> = ["dark", "light"]

/**
 * Terminal backgrounds a transparent theme is read against: black, a common
 * default (Ghostty, iTerm), One Dark; white, paper, Solarized Light.
 */
const REFERENCE_BACKGROUNDS = {
  dark: ["#000000", "#1d1f21", "#282c34"],
  light: ["#ffffff", "#f5f5f5", "#fdf6e3"],
} as const

/**
 * Every pair under its minimum, one line each:
 * `<theme> <mode> <token> #hex <ratio> < <min> on <surface>`.
 */
const contrastFailures = (
  name: string,
  json: (typeof DEFAULT_THEMES)[keyof typeof DEFAULT_THEMES],
  mode: "dark" | "light",
): ReadonlyArray<string> => {
  const failures = new Set<string>()
  for (const reference of REFERENCE_BACKGROUNDS[mode]) {
    const terminal = RGBA.fromHex(reference)
    const theme = resolveTheme(json, mode, Option.some(terminal))
    const opaque = Option.filter(Option.some(theme.background), (color) => color.a > 0)
    const background = Option.getOrElse(opaque, () => terminal)
    const surface = Option.match(opaque, {
      onNone: () => reference,
      onSome: (color) => `background ${rgbToHex(color)}`,
    })
    const check = (token: string, color: RGBA, on: RGBA, min: number, where: string) => {
      const ratio = contrastRatio(color, on)
      if (color.a > 0 && ratio >= min) return
      failures.add(
        `${name} ${mode} ${token} ${rgbToHex(color)} ${ratio.toFixed(2)} < ${min} on ${where}`,
      )
    }
    for (const token of TEXT_TOKENS) {
      check(token, theme[token], background, MIN_TEXT_CONTRAST, surface)
    }
    check("border", theme.border, background, MIN_GLYPH_CONTRAST, surface)
    check(
      "selectedListItemText",
      theme.selectedListItemText,
      theme.primary,
      MIN_TEXT_CONTRAST,
      `primary ${rgbToHex(theme.primary)}`,
    )
    for (const token of PANEL_TEXT_TOKENS) {
      check(
        token,
        theme[token],
        theme.backgroundPanel,
        MIN_TEXT_CONTRAST,
        `backgroundPanel ${rgbToHex(theme.backgroundPanel)}`,
      )
    }
    check(
      "text",
      theme.text,
      theme.textMuted,
      MIN_MUTED_STEP,
      `textMuted ${rgbToHex(theme.textMuted)}`,
    )
  }
  return [...failures]
}

describe("bundled theme catalog", () => {
  it.live("every bundled theme resolves both variants with no missing color", () =>
    Effect.sync(() => {
      const entries = Object.entries(DEFAULT_THEMES)
      expect(entries.length).toBe(7)
      const modes: ReadonlyArray<"dark" | "light"> = ["dark", "light"]
      for (const [, json] of entries) {
        for (const mode of modes) {
          const resolved = resolveTheme(json, mode)
          // Six of the seven omit `selectedListItemText`, and fx omits
          // `backgroundPanel`; `resolveTheme` supplies both, so the catalog
          // is uniform downstream.
          expect(Object.keys(resolved).sort()).toEqual([...THEME_KEYS].sort())
          for (const key of THEME_KEYS) {
            expect(Number.isFinite(resolved[key].r)).toBe(true)
          }
        }
      }
    }),
  )

  it.live(
    "every bundled theme reads at a glance: text 4.5:1, borders 3:1, a step between text and muted",
    () =>
      Effect.sync(() => {
        const failures = Object.entries(DEFAULT_THEMES).flatMap(([name, json]) =>
          MODES.flatMap((mode) => contrastFailures(name, json, mode)),
        )
        expect(failures).toEqual([])
      }),
  )

  // fx's text stays gray; failures, attention, success and names each have a hue.
  it.live("fx's semantic colors differ from text", () =>
    Effect.sync(() => {
      for (const mode of MODES) {
        const theme = resolveTheme(DEFAULT_THEMES.fx, mode)
        const hues = [theme.error, theme.warning, theme.success, theme.info].map(rgbToHex)
        expect(hues).not.toContain(rgbToHex(theme.text))
        expect(new Set(hues).size).toBe(hues.length)
      }
    }),
  )

  it.live(
    "backgroundPanel derives from the terminal's background and is absent when it is unknown",
    () =>
      Effect.sync(() => {
        const onDark = resolveTheme(DEFAULT_THEMES.fx, "dark", Option.some(RGBA.fromHex("#1d1f21")))
        // Codex's fill, #383a3c, faded until textMuted reads on it.
        expect(rgbToHex(onDark.backgroundPanel)).toBe("#343638")
        const onLight = resolveTheme(
          DEFAULT_THEMES.fx,
          "light",
          Option.some(RGBA.fromHex("#ffffff")),
        )
        expect(rgbToHex(onLight.backgroundPanel)).toBe("#f5f5f5")
        expect(resolveTheme(DEFAULT_THEMES.fx, "dark").backgroundPanel.a).toBe(0)
      }),
  )

  // A theme written for the earlier token set, or an opencode theme with
  // tokens gent does not draw, still resolves to the current set.
  it.live("a theme with retired tokens and no backgroundPanel resolves to the current set", () =>
    Effect.sync(() => {
      const retired = {
        ...DEFAULT_THEMES.fx,
        theme: {
          ...DEFAULT_THEMES.fx.theme,
          backgroundElement: { dark: "#4e4e4e", light: "#c6c6c6" },
          backgroundMenu: { dark: "ink", light: "#ffffff" },
          borderSubtle: "border",
        },
      }
      for (const mode of MODES) {
        const resolved = resolveTheme(retired, mode, Option.some(RGBA.fromHex("#000000")))
        expect(Object.keys(resolved).sort()).toEqual([...THEME_KEYS].sort())
        expect(resolved).toEqual(
          resolveTheme(DEFAULT_THEMES.fx, mode, Option.some(RGBA.fromHex("#000000"))),
        )
      }
    }),
  )
})

describe("palette theme level", () => {
  it.scopedLive("lists every registered theme, not just a dark/light pair", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <OpenPaletteOnMount />, { width: 90, height: 40 })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Commands") && frame.includes("Theme"),
        "commands root",
      )
      // Theme is the first row.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("System"), "theme level")
      const frame = renderFrame(setup)
      // System plus every registered theme. The list viewport clips before the
      // last rows, so the level's own count is what proves the whole catalog is
      // reachable rather than a hardcoded trio.
      expect(frame).toContain(`Theme ${Object.keys(DEFAULT_THEMES).length + 1}`)
      for (const name of ["fx", "opencode", "catppuccin", "dracula", "nord"]) {
        expect(frame).toContain(name)
      }
      // The variant toggle is its own level; the theme list is names only.
      expect(frame).not.toContain("Dark")
      expect(frame).not.toContain("Light")
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("keeps Dark and Light on a separate Mode level", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <OpenPaletteOnMount />, { width: 90, height: 40 })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Commands") && frame.includes("Mode"),
        "commands root",
      )
      // Mode is the second row.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Dark") && frame.includes("Light"),
        "mode level",
      )
      const frame = renderFrame(setup)
      // A mode is a variant, not a theme: no catalog name rides along.
      expect(frame).not.toContain("catppuccin")
    }).pipe(Effect.timeout("20 seconds")),
  )
})
