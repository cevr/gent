import { createContext, createMemo, onMount, onCleanup, untrack } from "solid-js"
import { useRequiredContext } from "../utils/solid-context"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useRenderer } from "@opentui/solid"
import { Option } from "effect"
import type { Theme, ThemeJson, ThemeMode } from "./types"
import { resolveTheme, generateSystemTheme } from "./resolve"
import { DEFAULT_THEMES } from "./default-themes"

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
