/** @jsxImportSource @opentui/solid */
/**
 * The palette's Theme level over the bundled catalog.
 *
 * Every registered theme is selectable, and the Dark/Light variant is its own
 * level: picking a theme must not silently move the mode, and picking a mode
 * must not silently move the theme.
 */
import { describe, expect, it } from "effect-bun-test"
import { createEffect } from "solid-js"
import { Effect } from "effect"
import { CommandPalette } from "../../src/components/command-palette"
import { useCommand } from "../../src/command/context"
import { DEFAULT_THEMES } from "../../src/theme/default-themes"
import { resolveTheme } from "../../src/theme/resolve"
import type { Theme } from "../../src/theme/types"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

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
      const names = Object.keys(DEFAULT_THEMES)
      expect(names.length).toBe(7)
      for (const name of names) {
        for (const mode of ["dark", "light"] as const) {
          const resolved = resolveTheme(
            DEFAULT_THEMES[name as keyof typeof DEFAULT_THEMES],
            mode,
          )
          // Six of the seven omit `selectedListItemText` and `backgroundMenu`;
          // `resolveTheme` supplies both, so the catalog is uniform downstream.
          expect(Object.keys(resolved).sort()).toEqual([...THEME_KEYS].sort())
          for (const key of THEME_KEYS) {
            expect(typeof resolved[key].r).toBe("number")
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
