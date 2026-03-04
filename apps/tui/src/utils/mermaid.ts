/**
 * Mermaid diagram extraction and ASCII rendering.
 *
 * Detects ```mermaid fenced blocks in markdown, renders them
 * to ASCII art via beautiful-mermaid, and caches results.
 */

import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid"

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
  let match = regex.exec(text)

  while (match !== null) {
    const source = match[1]?.trim()
    if (source !== undefined && source.length > 0) {
      blocks.push({
        source,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      })
    }
    match = regex.exec(text)
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

function getMaxLineWidth(text: string): number {
  let max = 0
  for (const line of text.split("\n")) {
    // Strip ANSI escape codes for accurate width
    // eslint-disable-next-line no-control-regex
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "")
    if (stripped.length > max) max = stripped.length
  }
  return max
}

/**
 * Try each preset from roomy → tightest. Pick the first whose
 * rendered output fits within maxWidth. Falls back to tightest.
 */
export function pickBestPreset(source: string, maxWidth: number): AsciiRenderOptions | undefined {
  for (const preset of PRESETS) {
    try {
      const ascii = renderMermaidASCII(source, {
        paddingX: preset.paddingX,
        paddingY: preset.paddingY,
        boxBorderPadding: preset.boxBorderPadding,
      })
      if (ascii !== undefined && ascii.length > 0) {
        const width = getMaxLineWidth(ascii)
        if (width <= maxWidth) {
          return {
            paddingX: preset.paddingX,
            paddingY: preset.paddingY,
            boxBorderPadding: preset.boxBorderPadding,
          }
        }
      }
    } catch {
      // Try next preset
    }
  }
  // Return tightest as fallback
  const tightest = PRESETS[PRESETS.length - 1]
  if (tightest === undefined) return undefined
  return {
    paddingX: tightest.paddingX,
    paddingY: tightest.paddingY,
    boxBorderPadding: tightest.boxBorderPadding,
  }
}

// LRU cache for rendered diagrams — keyed by source + width
const CACHE_MAX = 20
const renderCache = new Map<string, string>()

function hashSource(source: string, maxWidth?: number): string {
  const hasher = new Bun.CryptoHasher("md5")
  hasher.update(source)
  if (maxWidth !== undefined) hasher.update(`:${maxWidth}`)
  return hasher.digest("hex")
}

/**
 * Render a mermaid diagram to ASCII art.
 * When maxWidth is provided, uses adaptive preset selection.
 * Results are cached (LRU).
 */
export function renderMermaidToAscii(source: string, maxWidth?: number): string | undefined {
  const key = hashSource(source, maxWidth)
  const cached = renderCache.get(key)
  if (cached !== undefined) {
    // Move to end for LRU
    renderCache.delete(key)
    renderCache.set(key, cached)
    return cached
  }

  try {
    const options = maxWidth !== undefined ? pickBestPreset(source, maxWidth) : undefined
    const ascii = renderMermaidASCII(source, options)
    if (ascii === undefined || ascii.length === 0) return undefined

    // Evict oldest if at capacity
    if (renderCache.size >= CACHE_MAX) {
      const oldest = renderCache.keys().next()
      if (!oldest.done) {
        renderCache.delete(oldest.value)
      }
    }
    renderCache.set(key, ascii)
    return ascii
  } catch {
    return undefined
  }
}

/**
 * Replace mermaid blocks in text with rendered ASCII art.
 * Falls back to the original code block if rendering fails.
 */
export function replaceMermaidBlocks(text: string, maxWidth?: number): string {
  const blocks = extractMermaidBlocks(text)
  if (blocks.length === 0) return text

  let result = ""
  let lastEnd = 0

  for (const block of blocks) {
    result += text.slice(lastEnd, block.startIndex)

    const ascii = renderMermaidToAscii(block.source, maxWidth)
    if (ascii !== undefined) {
      result += ascii
    } else {
      // Fallback: show original code block
      result += text.slice(block.startIndex, block.endIndex)
    }

    lastEnd = block.endIndex
  }

  result += text.slice(lastEnd)
  return result
}
