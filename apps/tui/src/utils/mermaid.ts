/**
 * Mermaid diagram extraction and ASCII rendering.
 *
 * Detects ```mermaid fenced blocks in markdown, renders them
 * to ASCII art via beautiful-mermaid, and caches results.
 */

import { renderMermaidASCII } from "beautiful-mermaid"

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

// LRU cache for rendered diagrams — keyed by source content hash
const CACHE_MAX = 10
const renderCache = new Map<string, string>()

function hashSource(source: string): string {
  // Simple hash via Bun
  const hasher = new Bun.CryptoHasher("md5")
  hasher.update(source)
  return hasher.digest("hex")
}

/**
 * Render a mermaid diagram to ASCII art.
 * Results are cached (LRU, 10 entries).
 */
export function renderMermaidToAscii(source: string): string | undefined {
  const key = hashSource(source)
  const cached = renderCache.get(key)
  if (cached !== undefined) {
    // Move to end for LRU
    renderCache.delete(key)
    renderCache.set(key, cached)
    return cached
  }

  try {
    const ascii = renderMermaidASCII(source)
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
export function replaceMermaidBlocks(text: string): string {
  const blocks = extractMermaidBlocks(text)
  if (blocks.length === 0) return text

  let result = ""
  let lastEnd = 0

  for (const block of blocks) {
    result += text.slice(lastEnd, block.startIndex)

    const ascii = renderMermaidToAscii(block.source)
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
