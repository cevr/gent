/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createThemeView, DEFAULT_THEMES, resolveTheme, type Theme } from "../src/theme"
import { Effect } from "effect"
import { CommandPalette, useCommand } from "../src/commands"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"

// ── theme-view.test ─────────────────────────────────────────────────────────

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
    expect(color).toBe(expected.get(key))
  }
}

describe("theme view", () => {
  test("every resolved theme key is reachable on the view as an enumerable getter", () => {
    createRoot((dispose) => {
      const [values] = createSignal(dark)
      const view = createThemeView(values)
      expect(keysOf(view)).toEqual(keysOf(dark))
      for (const key of Object.keys(view)) {
        const descriptor = Object.getOwnPropertyDescriptor(view, key)
        expect(descriptor).toBeDefined()
        // A data-property descriptor carries no `get` key at all.
        expect("get" in descriptor!).toBe(true)
        expect(descriptor!.enumerable).toBe(true)
      }
      expectViewToMirror(view, dark)
      dispose()
    })
  })

  test("a theme swap shows through every key on the same view object", () => {
    createRoot((dispose) => {
      const [values, setValues] = createSignal(dark)
      const view = createThemeView(values)
      expect(view.primary).toBe(dark.primary)
      expect(dark.background).not.toBe(light.background)
      setValues(light)
      expectViewToMirror(view, light)
      expect(view.background).toBe(light.background)
      dispose()
    })
  })
})

// ── components/theme-picker.test ────────────────────────────────────────────

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
    command.openPalette()
  })
  return <CommandPalette />
}

/** Every key the app reads off a theme; a hole here renders as a missing color. */
const THEME_KEYS: ReadonlyArray<keyof Theme> = [
  "primary",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "selectedListItemText",
  "background",
  "backgroundElement",
  "backgroundMenu",
  "border",
  "borderSubtle",
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
]

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
  it.live("lists every registered theme, not just a dark/light pair", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, { width: 90, height: 40 }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Theme"),
          "commands root",
        ),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("System"), "theme level"),
      )
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

  it.live("keeps Dark and Light on a separate Mode level", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, { width: 90, height: 40 }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Mode"),
          "commands root",
        ),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Dark") && frame.includes("Light"),
          "mode level",
        ),
      )
      const frame = renderFrame(setup)
      // A mode is a variant, not a theme: no catalog name rides along.
      expect(frame).not.toContain("catppuccin")
    }).pipe(Effect.timeout("20 seconds")),
  )
})
