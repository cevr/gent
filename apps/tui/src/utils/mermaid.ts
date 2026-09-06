/**
 * Mermaid diagram extraction and ASCII rendering.
 *
 * Detects ```mermaid fenced blocks in markdown, renders them
 * to ASCII art via beautiful-mermaid, and caches results.
 */

import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid"
import { Effect, Option, Schema } from "effect"

export interface MermaidBlock {
  /** Original mermaid source code */
  source: string
  /** Start index in the original text */
  startIndex: number
  /** End index in the original text */
  endIndex: number
}

/**
 * Extract mermaid fenced code blocks from markdown text.
 * Looks for ```mermaid ... ``` patterns.
 */
export function extractMermaidBlocks(text: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  const regex = /```mermaid\s*\n([\s\S]*?)```/g
  let match = Option.fromNullishOr(regex.exec(text))

  while (Option.isSome(match)) {
    const result = match.value
    const source = Option.map(Option.fromNullishOr(result[1]), (value) => value.trim())
    if (Option.isSome(source) && source.value.length > 0) {
      blocks.push({
        source: source.value,
        startIndex: result.index,
        endIndex: result.index + result[0].length,
      })
    }
    match = Option.fromNullishOr(regex.exec(text))
  }

  return blocks
}

// Adaptive density presets — from roomy to tightest

interface Preset {
  name: string
  paddingX: number
  paddingY: number
  boxBorderPadding: number
}

const PRESETS: readonly Preset[] = [
  { name: "roomy", paddingX: 8, paddingY: 5, boxBorderPadding: 2 },
  { name: "normal", paddingX: 5, paddingY: 3, boxBorderPadding: 1 },
  { name: "compact", paddingX: 3, paddingY: 2, boxBorderPadding: 1 },
  { name: "tight", paddingX: 2, paddingY: 1, boxBorderPadding: 1 },
  { name: "tightest", paddingX: 1, paddingY: 1, boxBorderPadding: 0 },
]
const TIGHTEST_PRESET: Preset = { name: "tightest", paddingX: 1, paddingY: 1, boxBorderPadding: 0 }

function getMaxLineWidth(text: string): number {
  let max = 0
  for (const line of text.split("\n")) {
    // Strip ANSI escape codes for accurate width
    // eslint-disable-next-line no-control-regex -- ANSI escape stripping needs literal control-byte patterns
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "")
    if (stripped.length > max) max = stripped.length
  }
  return max
}

/**
 * Try each preset from roomy → tightest. Pick the first whose
 * rendered output fits within maxWidth. Falls back to tightest.
 */
export function pickBestPreset(source: string, maxWidth: number): AsciiRenderOptions {
  for (const preset of PRESETS) {
    const rendered = Effect.runSync(
      Effect.option(
        Effect.try(() =>
          renderMermaidASCII(source, {
            paddingX: preset.paddingX,
            paddingY: preset.paddingY,
            boxBorderPadding: preset.boxBorderPadding,
          }),
        ),
      ),
    )
    if (Option.isSome(rendered)) {
      const ascii = Option.fromNullishOr(rendered.value)
      if (Option.isSome(ascii) && ascii.value.length > 0) {
        const width = getMaxLineWidth(ascii.value)
        if (width <= maxWidth) {
          return {
            paddingX: preset.paddingX,
            paddingY: preset.paddingY,
            boxBorderPadding: preset.boxBorderPadding,
          }
        }
      }
    }
  }
  // Return tightest as fallback
  return {
    paddingX: TIGHTEST_PRESET.paddingX,
    paddingY: TIGHTEST_PRESET.paddingY,
    boxBorderPadding: TIGHTEST_PRESET.boxBorderPadding,
  }
}

// LRU cache for rendered diagrams — keyed by source + width. The cache is
// bounded by `CACHE_MAX` so memory stays bounded; the key is structured
// JSON so a source string that happens to contain a `:<width>` suffix
// cannot collide with a separate `(source, width)` call.
const CACHE_MAX = 20
const renderCache = new Map<string, string>()

const encodeCacheKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ source: Schema.String, maxWidth: Schema.optional(Schema.Finite) }),
  ),
)

const cacheKey = (source: string, maxWidth: number): string => encodeCacheKey({ source, maxWidth })

/**
 * Render a mermaid diagram to ASCII art.
 * When maxWidth is provided, uses adaptive preset selection.
 * Results are cached (LRU).
 */
export function renderMermaidToAscii(source: string, maxWidth: number): Option.Option<string> {
  const key = cacheKey(source, maxWidth)
  const cached = Option.fromNullishOr(renderCache.get(key))
  if (Option.isSome(cached)) {
    // Move to end for LRU
    renderCache.delete(key)
    renderCache.set(key, cached.value)
    return cached
  }

  const options = pickBestPreset(source, maxWidth)
  const rendered = Effect.runSync(
    Effect.option(Effect.try(() => renderMermaidASCII(source, options))),
  )
  if (Option.isNone(rendered)) return Option.none()
  const ascii = Option.fromNullishOr(rendered.value)
  if (Option.isNone(ascii) || ascii.value.length === 0) return Option.none()

  // Evict oldest if at capacity
  if (renderCache.size >= CACHE_MAX) {
    const oldest = renderCache.keys().next()
    if (!oldest.done) {
      renderCache.delete(oldest.value)
    }
  }
  renderCache.set(key, ascii.value)
  return ascii
}

/**
 * Replace mermaid blocks in text with rendered ASCII art.
 * Falls back to the original code block if rendering fails.
 */
export function replaceMermaidBlocks(text: string, maxWidth: number): string {
  const blocks = extractMermaidBlocks(text)
  if (blocks.length === 0) return text

  let result = ""
  let lastEnd = 0

  for (const block of blocks) {
    result += text.slice(lastEnd, block.startIndex)

    const ascii = renderMermaidToAscii(block.source, maxWidth)
    if (Option.isSome(ascii)) {
      result += ascii.value
    } else {
      // Fallback: show original code block
      result += text.slice(block.startIndex, block.endIndex)
    }

    lastEnd = block.endIndex
  }

  result += text.slice(lastEnd)
  return result
}
