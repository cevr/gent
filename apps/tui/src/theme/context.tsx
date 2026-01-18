import { createContext, useContext, createMemo, onMount } from "solid-js"
import type { JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useRenderer } from "@opentui/solid"
import type { Theme, ThemeJson, ThemeMode } from "./types.js"
import { resolveTheme, generateSystemTheme } from "./resolve.js"
import { DEFAULT_THEMES } from "./default-themes.js"
import { detectColorScheme } from "./detect.js"

interface ThemeContextValue {
  theme: Theme
  selected: () => string
  all: () => Record<string, ThemeJson>
  mode: () => "dark" | "light"
  setMode: (mode: "dark" | "light") => void
  set: (theme: string) => void
  ready: boolean
}

const ThemeContext = createContext<ThemeContextValue>()

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
  return ctx
}

interface ThemeProviderProps {
  mode: ThemeMode | undefined
  children: JSX.Element
}

export function ThemeProvider(props: ThemeProviderProps) {
  const renderer = useRenderer()

  // Determine initial mode
  const initialMode = (): "dark" | "light" => {
    if (props.mode === "dark" || props.mode === "light") return props.mode
    return detectColorScheme()
  }

  const [store, setStore] = createStore({
    themes: DEFAULT_THEMES as Record<string, ThemeJson>,
    mode: initialMode(),
    active: "system" as string,
    ready: false,
  })

  function init() {
    resolveSystemTheme()
  }

  onMount(init)

  function resolveSystemTheme() {
    renderer
      .getPalette({ size: 16 })
      .then((colors) => {
        if (!colors.palette[0]) {
          // No palette available, fall back to opencode theme
          if (store.active === "system") {
            setStore(
              produce((draft) => {
                draft.active = "opencode"
                draft.ready = true
              })
            )
          }
          return
        }
        setStore(
          produce((draft) => {
            draft.themes["system"] = generateSystemTheme(colors, store.mode)
            if (store.active === "system") {
              draft.ready = true
            }
          })
        )
      })
      .catch(() => {
        // Fall back to opencode theme
        if (store.active === "system") {
          setStore(
            produce((draft) => {
              draft.active = "opencode"
              draft.ready = true
            })
          )
        }
      })
      .finally(() => {
        if (!store.ready) {
          setStore("ready", true)
        }
      })
  }

  // Listen for SIGUSR2 to refresh palette
  process.on("SIGUSR2", () => {
    renderer.clearPaletteCache()
    init()
  })

  const values = createMemo(() => {
    const activeTheme = store.themes[store.active] ?? store.themes["opencode"]
    if (!activeTheme) throw new Error(`Theme not found: ${store.active}`)
    return resolveTheme(activeTheme, store.mode)
  })

  // Create a reactive proxy for the theme
  const themeProxy = new Proxy({} as Theme, {
    get(_, prop) {
      return (values() as unknown as Record<string, unknown>)[prop as string]
    },
  })

  const value: ThemeContextValue = {
    theme: themeProxy,
    selected: () => store.active,
    all: () => store.themes,
    mode: () => store.mode,
    setMode: (mode: "dark" | "light") => {
      setStore("mode", mode)
    },
    set: (theme: string) => {
      setStore("active", theme)
    },
    get ready() {
      return store.ready
    },
  }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}
