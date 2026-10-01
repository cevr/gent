/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { createEffect } from "solid-js"
import { DEFAULT_THEMES, resolveTheme, type Theme, useTheme } from "../src/theme"
import { Effect, Option } from "effect"
import type { TerminalColors } from "@opentui/core"
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
    expect(color).toEqual(expected.get(key))
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

describe("system theme", () => {
  // The terminal's palette is read once; the theme drawn from it is the one
  // for the mode in force, so a mode switch redraws it for that mode.
  it.scopedLive("the terminal-derived theme follows a mode switch", () =>
    Effect.gen(function* () {
      const palette = Array.from(
        { length: 16 },
        (_, i) => `#${(i * 16).toString(16).padStart(2, "0").repeat(3)}`,
      )
      const colors = {
        palette,
        defaultForeground: "#dddddd",
        defaultBackground: "#202020",
        cursorColor: "#000000",
        mouseForeground: "#000000",
        mouseBackground: "#000000",
        tekForeground: "#000000",
        tekBackground: "#000000",
        highlightBackground: "#000000",
        highlightForeground: "#000000",
      } satisfies TerminalColors
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
      theme.set("system")
      theme.setMode("dark")
      const dark = theme.theme.backgroundElement
      theme.setMode("light")
      yield* waitForFrame(setup, () => true)
      expect(theme.theme.backgroundElement).not.toEqual(dark)
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
  backgroundElement: true,
  backgroundMenu: true,
  border: true,
  borderSubtle: true,
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

describe("bundled theme catalog", () => {
  it.live("every bundled theme resolves both variants with no missing color", () =>
    Effect.sync(() => {
      const entries = Object.entries(DEFAULT_THEMES)
      expect(entries.length).toBe(7)
      const modes: ReadonlyArray<"dark" | "light"> = ["dark", "light"]
      for (const [, json] of entries) {
        for (const mode of modes) {
          const resolved = resolveTheme(json, mode)
          // Six of the seven omit `selectedListItemText` and `backgroundMenu`;
          // `resolveTheme` supplies both, so the catalog is uniform downstream.
          expect(Object.keys(resolved).sort()).toEqual([...THEME_KEYS].sort())
          for (const key of THEME_KEYS) {
            expect(Number.isFinite(resolved[key].r)).toBe(true)
          }
        }
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
