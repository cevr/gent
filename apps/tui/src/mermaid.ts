import type * as BeautifulMermaid from "beautiful-mermaid"
import { useRenderer } from "@opentui/solid"
import { type Accessor, createMemo, createSignal } from "solid-js"
import {
  createMarkdownCodeBlockRenderer,
  type MarkdownCodeBlockRenderer,
  type MarkdownOptions,
  type RenderContext,
  type RGBA,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { Effect, Option } from "effect"

// ── mermaid diagrams ────────────────────────────────────────────────────────

/**
 * A ```mermaid fence in an answer draws as a diagram: a code-block renderer
 * that the answer's markdown calls for each mermaid fence, with
 * beautiful-mermaid behind it, as opencode v2 draws its diagrams. The
 * diagram is its own block, so markdown never reads its box art as text.
 */

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

// ── drawing ─────────────────────────────────────────────────────────────────

/** The theme colors a diagram draws in, one for each part of the drawing. */
interface DiagramColors {
  /** Node and edge labels. */
  readonly text: RGBA
  /** Node and subgraph boxes. */
  readonly border: RGBA
  /** The lines between nodes. */
  readonly line: RGBA
  /** Arrowheads. */
  readonly arrow: RGBA
}

type DiagramPart = keyof DiagramColors

/**
 * The compact spacing: no padding inside a node box, and one column and one
 * row between nodes. A row gap of 0 draws the edges through the boxes, so
 * one row is the shortest edge beautiful-mermaid draws whole.
 */
const COMPACT = { paddingX: 1, paddingY: 1, boxBorderPadding: 0 } as const

/**
 * beautiful-mermaid colors each cell of its drawing by the part it draws.
 * Each part gets a marker color whose blue channel names it; the drawing's
 * escapes are then read back into the theme's colors.
 */
const PART_MARKS = {
  fg: "#000001",
  border: "#000002",
  junction: "#000002",
  line: "#000003",
  corner: "#000003",
  arrow: "#000004",
} as const

const PART_OF_MARK: ReadonlyMap<string, DiagramPart> = new Map([
  ["38;2;0;0;1", "text"],
  ["38;2;0;0;2", "border"],
  ["38;2;0;0;3", "line"],
  ["38;2;0;0;4", "arrow"],
])

/** One SGR escape: its parameters are the captured group. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`)

/**
 * The drawing's escapes read as styled chunks: a run in a marker color takes
 * its part's theme color, and a run in any other color draws as a box.
 */
const styledDiagram = (drawn: string, colors: DiagramColors): StyledText => {
  const chunks: Array<TextChunk> = []
  let part = Option.none<DiagramPart>()
  // The split puts each escape's parameters at an odd index.
  drawn.split(SGR).forEach((piece, index) => {
    if (index % 2 === 1) {
      part = Option.none()
      if (piece === "" || piece === "0" || piece === "39") return
      part = Option.some(PART_OF_MARK.get(piece) ?? "border")
      return
    }
    if (piece.length === 0) return
    chunks.push(
      Option.match(part, {
        onNone: () => ({ __isChunk: true, text: piece }),
        onSome: (current) => ({ __isChunk: true, text: piece, fg: colors[current] }),
      }),
    )
  })
  return new StyledText(chunks)
}

/** A drawn diagram and the rows it takes. */
interface Diagram {
  readonly text: StyledText
  readonly height: number
}

/** The diagram of `source`, or none when beautiful-mermaid cannot read it. */
const drawDiagram = (
  library: DiagramLibrary,
  source: string,
  colors: DiagramColors,
): Option.Option<Diagram> =>
  Effect.runSync(
    Effect.option(
      Effect.try(() =>
        library.renderMermaidASCII(spaceEdgeArrows(source), {
          ...COMPACT,
          colorMode: "truecolor",
          theme: PART_MARKS,
        }),
      ),
    ),
  ).pipe(
    Option.map((drawn) => drawn.replace(/\n+$/, "")),
    Option.filter((drawn) => drawn.trim().length > 0),
    Option.map((drawn) => ({
      text: styledDiagram(drawn, colors),
      height: drawn.split("\n").length,
    })),
  )

// ── library ─────────────────────────────────────────────────────────────────

type DiagramLibrary = typeof BeautifulMermaid

/**
 * beautiful-mermaid loads on the first mermaid fence, not at launch: most
 * sessions draw no diagram. The load runs once; the signal tells every
 * reader when it lands.
 */
const [library, setLibrary] = createSignal(Option.none<DiagramLibrary>())

const loadLibrary = Effect.runSync(
  Effect.cached(
    // oxlint-disable-next-line effect/noDynamicImports -- the diagram library loads on the first mermaid fence, not at launch
    Effect.promise(() => import("beautiful-mermaid")).pipe(
      Effect.tap((loaded) => Effect.sync(() => setLibrary(Option.some(loaded)))),
    ),
  ),
)

/** The library, once loaded; asking for it starts the load. Reactive. */
const askLibrary = (): Option.Option<DiagramLibrary> => {
  const loaded = library()
  if (Option.isNone(loaded)) Effect.runFork(loadLibrary)
  return loaded
}

/** A ```mermaid or ~~~mermaid fence opens on one of the lines. */
const DIAGRAM_FENCE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid\b/m

/**
 * Whether `markdown` draws as it will stay: it holds no mermaid fence, or the
 * library its diagrams need has loaded. A fence starts the load. Reactive, so
 * native history can wait for the load before it commits the item.
 */
export const diagramsDrawable = (markdown: string): boolean =>
  !DIAGRAM_FENCE.test(markdown) || Option.isSome(askLibrary())

// ── code-block renderer ─────────────────────────────────────────────────────

/** The widest a diagram draws, as opencode's: a wider one is cut at the right. */
const DIAGRAM_MAX_WIDTH = 120

/** A fence is closed once its closing ``` or ~~~ line has arrived. */
const fenceClosed = (raw: string): boolean => /\n[ \t]*(?:`{3,}|~{3,})[ \t]*\n*$/.test(raw)

/** The statements whose line has ended: the line still being written waits. */
const completeStatements = (text: string): string =>
  text.slice(0, Math.max(0, text.lastIndexOf("\n")))

/**
 * The answer's markdown hook for ```mermaid fences, drawing on `ctx` with
 * `library`.
 *
 * - Before the library loads, a fence asks for it and draws as its code block.
 * - While the fence streams, the diagram draws its complete statements and
 *   redraws as each line ends. When the statements so far do not draw, the
 *   fence keeps its last diagram, keyed by the block's stable id as opencode
 *   keys it.
 * - Once the fence closes, a source that does not draw shows as the fenced
 *   code block (the hook returns nothing, so markdown draws its default).
 * - The diagram does not wrap and cannot be selected. It takes at most
 *   `DIAGRAM_MAX_WIDTH` columns of the answer; a wider one is cut at the
 *   right. The native transcript has no mouse, so it does not scroll sideways.
 */
const mermaidCodeBlocks = (
  ctx: RenderContext,
  library: Option.Option<DiagramLibrary>,
  colors: () => DiagramColors,
): MarkdownOptions["renderNode"] => {
  const lastDrawn = new Map<string, Diagram>()
  const shownDiagram = (
    loaded: DiagramLibrary,
    text: string,
    raw: string,
    block: Option.Option<string>,
  ) => {
    if (fenceClosed(raw)) return drawDiagram(loaded, text, colors())
    return Option.orElse(drawDiagram(loaded, completeStatements(text), colors()), () =>
      Option.flatMap(block, (id) => Option.fromUndefinedOr(lastDrawn.get(id))),
    )
  }
  const mermaid: MarkdownCodeBlockRenderer = (token, context) => {
    if (Option.isNone(library)) askLibrary()
    const block = Option.fromNullishOr(context.defaultRender()?.id)
    const diagram = Option.flatMap(library, (loaded) =>
      shownDiagram(loaded, token.text, token.raw, block),
    )
    const shown = Option.map(diagram, (diagram) => {
      Option.map(block, (id) => lastDrawn.set(id, diagram))
      return new TextRenderable(ctx, {
        content: diagram.text,
        width: "100%",
        maxWidth: DIAGRAM_MAX_WIDTH,
        height: diagram.height,
        wrapMode: "none",
        selectable: false,
        // The blank row before the diagram, as before any other block.
        marginTop: 1,
      })
    })
    // Nothing shown: markdown draws the fence as its code block.
    return Option.getOrUndefined(shown)
  }
  return createMarkdownCodeBlockRenderer({ mermaid })
}

/**
 * The markdown hook of one answer, for the renderer it draws on. It is one
 * value until the library loads, then one more: a new hook rebuilds every
 * block of the answer, so its fences draw as diagrams.
 */
export const useDiagramCodeBlocks = (
  colors: () => DiagramColors,
): Accessor<MarkdownOptions["renderNode"]> => {
  const ctx = useRenderer()
  return createMemo(() => mermaidCodeBlocks(ctx, library(), colors))
}
