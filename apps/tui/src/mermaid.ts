import { renderMermaidASCII } from "beautiful-mermaid"
import { Effect, Option, Schema } from "effect"
import { createContext, useContext } from "solid-js"
import { textWidth } from "./bun-adapter"

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

/** The widest line in terminal columns: a CJK label takes two a character. */
function getMaxLineWidth(text: string): number {
  let max = 0
  for (const line of text.split("\n")) max = Math.max(max, textWidth(line))
  return max
}

// ── edge arrows ─────────────────────────────────────────────────────────────

/**
 * Mermaid reads `A-->B` as `A --> B`. beautiful-mermaid 1.1.3 reads a
 * flowchart node id as `[\w-]+`, so an id written against a dash arrow takes
 * the arrow's dashes (`A--`) and the rest of the line is lost. A space between
 * the id and the arrow gives the parser the edge Mermaid reads. Text in a
 * shape, a quote or an edge label stays as written.
 */
const WRITTEN_TEXT = /("[^"]*"|\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\|[^|]*\|)/

/** An id character right before a dash arrow: `-->`, `---`, `-.->`, `-.-`, or a `-- text -->` start. */
const ID_AGAINST_ARROW = /(?<=\w)(?=-->|---|-\.->|-\.-|--\s|-\.\s)/g

const FLOWCHART_HEADER = /^(?:graph|flowchart)\b/

/** The first line that is not blank or a `%%` comment names the diagram. */
const isFlowchart = (lines: ReadonlyArray<string>): boolean =>
  Option.match(
    Option.fromUndefinedOr(
      lines.map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("%%")),
    ),
    { onNone: () => false, onSome: (header) => FLOWCHART_HEADER.test(header) },
  )

/**
 * A line that is not an edge statement: the diagram header, a comment, or a
 * subgraph, style, class or click line, whose text holds no edge.
 */
const NOT_AN_EDGE =
  /^(?:%%|(?:graph|flowchart|subgraph|end|direction|style|classDef|class|linkStyle|click)\b)/

/** One edge statement with a space between each id and the dash arrow written against it. */
const spaceLineArrows = (line: string): string => {
  if (NOT_AN_EDGE.test(line.trim())) return line
  return line
    .split(WRITTEN_TEXT)
    .map((part, index) => {
      // The split puts each quoted or shaped run at an odd index.
      if (index % 2 === 1) return part
      return part.replace(ID_AGAINST_ARROW, " ")
    })
    .join("")
}

/** A statement whose value holds `;` (`fill:#f9f;stroke:#333`): its text runs to the end of the line. */
const STYLE_STATEMENT = /^(?:style|classDef|linkStyle)\b/

/**
 * Mermaid reads `;` as a statement separator; beautiful-mermaid 1.1.3 reads
 * one statement per line, so `graph TD;` names no diagram and `A-->B; B-->C`
 * loses its second edge. Each statement goes on its own line. A `;` inside
 * written text stays as written. A `%%` comment and a style statement run to
 * the end of the line, so a `;` in either splits nothing.
 */
const splitStatements = (line: string): ReadonlyArray<string> => {
  if (!line.includes(";")) return [line]
  const statements: Array<string> = []
  let current = ""
  // Once a comment or a style statement starts, the rest of the line is its text.
  let toLineEnd = false
  line.split(WRITTEN_TEXT).forEach((part, index) => {
    // The split puts each quoted or shaped run at an odd index.
    if (toLineEnd || index % 2 === 1) {
      current += part
      return
    }
    const commentAt = part.indexOf("%%")
    let code = part
    if (commentAt !== -1) code = part.slice(0, commentAt)
    const [first = "", ...rest] = code.split(";")
    current += first
    for (const [at, next] of rest.entries()) {
      if (STYLE_STATEMENT.test(current.trim())) {
        current += ";" + rest.slice(at).join(";")
        toLineEnd = true
        break
      }
      statements.push(current)
      current = next
    }
    if (commentAt !== -1) {
      current += part.slice(commentAt)
      toLineEnd = true
    }
  })
  statements.push(current)
  return statements.filter((statement) => statement.trim().length > 0)
}

/**
 * The flowchart source beautiful-mermaid draws as Mermaid does: one statement
 * per line, and a space between each id and the dash arrow written against it.
 */
const spaceEdgeArrows = (source: string): string => {
  const lines = source.split("\n")
  if (!isFlowchart(lines)) return source
  return lines.flatMap(splitStatements).map(spaceLineArrows).join("\n")
}

/**
 * beautiful-mermaid colors its drawing with ANSI escapes when stdout is a
 * color terminal, as the TUI's is. The transcript draws its text as written,
 * so the escapes would print as text and wrap the diagram: draw it plain.
 */
const renderWith = (source: string, preset: Preset): Option.Option<string> =>
  Effect.runSync(
    Effect.option(Effect.try(() => renderMermaidASCII(source, { ...preset, colorMode: "none" }))),
  ).pipe(
    Option.flatMap(Option.fromNullishOr),
    Option.filter((ascii) => ascii.length > 0),
  )

/**
 * Render with each preset from roomy to tightest, once each, and keep the
 * first render that fits `maxWidth`. When none fits, keep the tightest render
 * that succeeded.
 */
function renderMermaidToAscii(written: string, maxWidth: number): Option.Option<string> {
  const source = spaceEdgeArrows(written)
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
