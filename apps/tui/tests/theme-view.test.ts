import { describe, expect, test } from "effect-bun-test"
import { createRoot, createSignal } from "solid-js"
import { createThemeView, DEFAULT_THEMES, resolveTheme, type Theme } from "../src/theme"

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
