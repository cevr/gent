import { createContext, useContext, createMemo, onMount, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useRenderer } from "@opentui/solid"
import type { Theme, ThemeJson, ThemeMode } from "./types"
import { resolveTheme, generateSystemTheme } from "./resolve"
import { DEFAULT_THEMES } from "./default-themes"
import { detectColorScheme } from "./detect"

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
  if (ctx === undefined) throw new Error("useTheme must be used within ThemeProvider")
  return ctx
}

interface ThemeProviderProps {
  mode: ThemeMode | undefined
  children: JSX.Element
}

const createThemeView = (values: () => Theme): Theme => ({
  get primary() {
    return values().primary
  },
  get secondary() {
    return values().secondary
  },
  get accent() {
    return values().accent
  },
  get error() {
    return values().error
  },
  get warning() {
    return values().warning
  },
  get success() {
    return values().success
  },
  get info() {
    return values().info
  },
  get text() {
    return values().text
  },
  get textMuted() {
    return values().textMuted
  },
  get selectedListItemText() {
    return values().selectedListItemText
  },
  get background() {
    return values().background
  },
  get backgroundPanel() {
    return values().backgroundPanel
  },
  get backgroundElement() {
    return values().backgroundElement
  },
  get backgroundMenu() {
    return values().backgroundMenu
  },
  get border() {
    return values().border
  },
  get borderActive() {
    return values().borderActive
  },
  get borderSubtle() {
    return values().borderSubtle
  },
  get diffAdded() {
    return values().diffAdded
  },
  get diffRemoved() {
    return values().diffRemoved
  },
  get diffContext() {
    return values().diffContext
  },
  get diffHunkHeader() {
    return values().diffHunkHeader
  },
  get diffHighlightAdded() {
    return values().diffHighlightAdded
  },
  get diffHighlightRemoved() {
    return values().diffHighlightRemoved
  },
  get diffAddedBg() {
    return values().diffAddedBg
  },
  get diffRemovedBg() {
    return values().diffRemovedBg
  },
  get diffContextBg() {
    return values().diffContextBg
  },
  get diffLineNumber() {
    return values().diffLineNumber
  },
  get diffAddedLineNumberBg() {
    return values().diffAddedLineNumberBg
  },
  get diffRemovedLineNumberBg() {
    return values().diffRemovedLineNumberBg
  },
  get markdownText() {
    return values().markdownText
  },
  get markdownHeading() {
    return values().markdownHeading
  },
  get markdownLink() {
    return values().markdownLink
  },
  get markdownLinkText() {
    return values().markdownLinkText
  },
  get markdownCode() {
    return values().markdownCode
  },
  get markdownBlockQuote() {
    return values().markdownBlockQuote
  },
  get markdownEmph() {
    return values().markdownEmph
  },
  get markdownStrong() {
    return values().markdownStrong
  },
  get markdownHorizontalRule() {
    return values().markdownHorizontalRule
  },
  get markdownListItem() {
    return values().markdownListItem
  },
  get markdownListEnumeration() {
    return values().markdownListEnumeration
  },
  get markdownImage() {
    return values().markdownImage
  },
  get markdownImageText() {
    return values().markdownImageText
  },
  get markdownCodeBlock() {
    return values().markdownCodeBlock
  },
  get syntaxComment() {
    return values().syntaxComment
  },
  get syntaxKeyword() {
    return values().syntaxKeyword
  },
  get syntaxFunction() {
    return values().syntaxFunction
  },
  get syntaxVariable() {
    return values().syntaxVariable
  },
  get syntaxString() {
    return values().syntaxString
  },
  get syntaxNumber() {
    return values().syntaxNumber
  },
  get syntaxType() {
    return values().syntaxType
  },
  get syntaxOperator() {
    return values().syntaxOperator
  },
  get syntaxPunctuation() {
    return values().syntaxPunctuation
  },
  get _hasSelectedListItemText() {
    return values()._hasSelectedListItemText
  },
  get thinkingOpacity() {
    return values().thinkingOpacity
  },
})

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
        if (colors.palette[0] === undefined) {
          // No palette available, fall back to opencode theme
          if (store.active === "system") {
            setStore(
              produce((draft) => {
                draft.active = "opencode"
                draft.ready = true
              }),
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
          }),
        )
      })
      .catch(() => {
        // Fall back to opencode theme
        if (store.active === "system") {
          setStore(
            produce((draft) => {
              draft.active = "opencode"
              draft.ready = true
            }),
          )
        }
      })
      .finally(() => {
        if (store.ready === false) {
          setStore("ready", true)
        }
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
    const activeTheme = store.themes[store.active] ?? store.themes["opencode"]
    if (activeTheme === undefined) throw new Error(`Theme not found: ${store.active}`)
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
    get ready() {
      return store.ready
    },
  }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}
