import { renderMermaidASCII } from "beautiful-mermaid"
import { Effect, Option, Schema } from "effect"
import { createContext, useContext } from "solid-js"

// ── mermaid rendering ───────────────────────────────────────────────────────

/**
 * Mermaid diagram extraction and ASCII rendering.
 *
 * Detects ```mermaid fenced blocks in markdown and renders them to ASCII art
 * via beautiful-mermaid. A session view holds one cache for its renders.
 */

interface MermaidBlock {
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
  paddingX: number
  paddingY: number
  boxBorderPadding: number
}

const PRESETS: readonly Preset[] = [
  { paddingX: 8, paddingY: 5, boxBorderPadding: 2 },
  { paddingX: 5, paddingY: 3, boxBorderPadding: 1 },
  { paddingX: 3, paddingY: 2, boxBorderPadding: 1 },
  { paddingX: 2, paddingY: 1, boxBorderPadding: 1 },
  { paddingX: 1, paddingY: 1, boxBorderPadding: 0 },
]

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

const renderWith = (source: string, preset: Preset): Option.Option<string> =>
  Effect.runSync(Effect.option(Effect.try(() => renderMermaidASCII(source, preset)))).pipe(
    Option.flatMap(Option.fromNullishOr),
    Option.filter((ascii) => ascii.length > 0),
  )

/**
 * Render with each preset from roomy to tightest, once each, and keep the
 * first render that fits `maxWidth`. When none fits, keep the tightest render
 * that succeeded.
 */
function renderMermaidToAscii(source: string, maxWidth: number): Option.Option<string> {
  let tightest = Option.none<string>()
  for (const preset of PRESETS) {
    const rendered = renderWith(source, preset)
    if (Option.isNone(rendered)) continue
    if (getMaxLineWidth(rendered.value) <= maxWidth) return rendered
    tightest = rendered
  }
  return tightest
}

// ── render cache ────────────────────────────────────────────────────────────

/**
 * The renders of one session view, keyed by source and width. A diagram is
 * drawn in the live transcript and again when it commits to scrollback; the
 * cache makes the second draw free. It is bounded by `CACHE_MAX`, least
 * recently used first out, and the key is structured JSON so a source that
 * ends in a width cannot collide with another (source, width) pair.
 */
interface MermaidCache {
  readonly renders: Map<string, string>
}

const CACHE_MAX = 20

export const createMermaidCache = (): MermaidCache => ({ renders: new Map() })

/** The session view's cache; outside one, each render runs uncached. */
export const MermaidCacheContext = createContext<Option.Option<MermaidCache>>(Option.none())

const cacheKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ source: Schema.String, maxWidth: Schema.Finite })),
)

const cachedRender = (
  cache: MermaidCache,
  source: string,
  maxWidth: number,
): Option.Option<string> => {
  const key = cacheKey({ source, maxWidth })
  const cached = Option.fromNullishOr(cache.renders.get(key))
  if (Option.isSome(cached)) {
    // Move to end for LRU
    cache.renders.delete(key)
    cache.renders.set(key, cached.value)
    return cached
  }
  const ascii = renderMermaidToAscii(source, maxWidth)
  if (Option.isNone(ascii)) return ascii
  if (cache.renders.size >= CACHE_MAX) {
    const oldest = cache.renders.keys().next()
    if (!oldest.done) cache.renders.delete(oldest.value)
  }
  cache.renders.set(key, ascii.value)
  return ascii
}

/**
 * Replace mermaid blocks in text with rendered ASCII art, through the session
 * view's cache when there is one. A block that fails to render stays as its
 * code block.
 */
export const replaceMermaidBlocks = (
  cache: Option.Option<MermaidCache>,
): ((text: string, maxWidth: number) => string) => {
  const render = (source: string, maxWidth: number): Option.Option<string> =>
    Option.match(cache, {
      onNone: () => renderMermaidToAscii(source, maxWidth),
      onSome: (owned) => cachedRender(owned, source, maxWidth),
    })
  return (text, maxWidth) => {
    const blocks = extractMermaidBlocks(text)
    if (blocks.length === 0) return text

    let result = ""
    let lastEnd = 0
    for (const block of blocks) {
      result += text.slice(lastEnd, block.startIndex)
      result += Option.getOrElse(render(block.source, maxWidth), () =>
        text.slice(block.startIndex, block.endIndex),
      )
      lastEnd = block.endIndex
    }
    return result + text.slice(lastEnd)
  }
}

/** {@link replaceMermaidBlocks} through the session view's cache. */
export const useMermaidBlocks = (): ((text: string, maxWidth: number) => string) =>
  replaceMermaidBlocks(useContext(MermaidCacheContext))
