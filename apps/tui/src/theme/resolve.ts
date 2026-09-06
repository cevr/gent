import { RGBA, type TerminalColors } from "@opentui/core"
import { Effect, Option, Predicate, Record } from "effect"
import type { Theme, ThemeJson, ColorValue } from "./types"

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

  const { selectedListItemText, backgroundMenu, thinkingOpacity, ...colors } = theme.theme
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
    _hasSelectedListItemText: Option.isSome(selectedText),
    thinkingOpacity: thinkingOpacity ?? 0.6,
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
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

/**
 * Generate a theme from terminal colors (system theme)
 */
export function generateSystemTheme(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
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
      secondary: ansiColors.magenta,
      accent: ansiColors.cyan,
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,
      text: fg,
      textMuted,
      selectedListItemText: bg,
      background: bg,
      backgroundPanel: gray(2),
      backgroundElement: gray(3),
      backgroundMenu: gray(3),
      borderSubtle: gray(6),
      border: gray(7),
      borderActive: gray(8),
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffContext: gray(7),
      diffHunkHeader: gray(7),
      diffHighlightAdded: ansiColors.greenBright,
      diffHighlightRemoved: ansiColors.redBright,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg: gray(1),
      diffLineNumber: gray(6),
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: gray(7),
      markdownListItem: ansiColors.blue,
      markdownListEnumeration: ansiColors.cyan,
      markdownImage: ansiColors.blue,
      markdownImageText: ansiColors.cyan,
      markdownCodeBlock: fg,
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
