/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, type Duration, Effect, Option, Schedule } from "effect"
import * as BeautifulMermaid from "beautiful-mermaid"
import { type CliRendererExternalOutputEvent, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { MessageList, NativeTranscript, type SessionItem } from "../src/message-list"
import { DiagramLibraryContext, DiagramLibraryError, makeDiagramLibrary } from "../src/mermaid"
import { renderScoped } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"

// ── mermaid diagrams ────────────────────────────────────────────────────────

const syntaxStyle = () => SyntaxStyle.create()

/** The frame of an answer that holds one closed ```mermaid fence. */
const drawn = (source: string, width = 120) =>
  drawnAnswer(`\`\`\`mermaid\n${source}\n\`\`\``, width)

/** The frame of an answer, once a diagram draws in it. */
const drawnAnswer = (content: string, width = 120) =>
  Effect.gen(function* () {
    const setup = yield* renderScoped(
      () => (
        <MessageList
          items={[
            {
              _tag: "regular-message",
              id: "diagram",
              role: "assistant",
              content,
              reasoning: "",
              images: [],
              createdAt: 0,
              segments: [{ _tag: "text", content }],
            },
          ]}
          disclosure="collapsed"
          syntaxStyle={syntaxStyle}
        />
      ),
      { width, height: 40 },
    )
    // The diagram library loads on the first fence: the fence draws as code until then.
    return yield* waitForFrame(setup, (frame) => frame.includes("┌"), "the diagram")
  }).pipe(Effect.timeout("5 seconds"))

/** The rows from the diagram's first box top to its last box bottom. */
const diagramRows = (frame: string): ReadonlyArray<string> => {
  const rows = frame.split("\n")
  const first = rows.findIndex((row) => row.includes("┌"))
  const last = rows.findLastIndex((row) => row.includes("┘"))
  return rows.slice(first, last + 1)
}

/** An answer with one diagram, and the answer after it. */
const diagramThenTail = (): SessionItem[] => {
  const content = "```mermaid\ngraph LR\n  Alpha-->Beta\n```"
  return [
    {
      _tag: "regular-message",
      id: "diagram",
      role: "assistant",
      content,
      reasoning: "",
      images: [],
      createdAt: 0,
      segments: [{ _tag: "text", content }],
    },
    {
      _tag: "regular-message",
      id: "tail",
      role: "assistant",
      content: "AFTER-DIAGRAM",
      reasoning: "",
      images: [],
      createdAt: 1,
      segments: [{ _tag: "text", content: "AFTER-DIAGRAM" }],
    },
  ]
}

/** The text native history receives while `library` serves the diagrams. */
const historyWith = (library: ReturnType<typeof makeDiagramLibrary>) =>
  Effect.gen(function* () {
    const committed: string[] = []
    const setup = yield* renderScoped(
      () => {
        const renderer = useRenderer()
        renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
          committed.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
        })
        return (
          <DiagramLibraryContext.Provider value={library}>
            <NativeTranscript
              items={diagramThenTail()}
              settled
              streaming={false}
              footerHeight={3}
              expanded={false}
              disclosure="collapsed"
              displayRevision={0}
              overlayOpen={false}
              renderItems={(visible) => (
                <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
              )}
            >
              <box />
            </NativeTranscript>
          </DiagramLibraryContext.Provider>
        )
      },
      { width: 60, height: 20 },
    )
    /** Draws frames until history holds `text`, or `within` passes. */
    const flushUntil = (text: string, within: Duration.Input) =>
      Effect.promise(() => setup.flush()).pipe(
        Effect.repeat({
          until: () => committed.join("").includes(text),
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout(within),
        Effect.ignore,
      )
    return { history: () => committed.join(""), flushUntil }
  })

// The diagram library loads on the first fence. Scrollback keeps forever
// what it is given, so an answer with a diagram waits for the load, and
// the answers after it wait in order.
describe("mermaid diagrams in native history", () => {
  it.scopedLive("an answer with a diagram waits for the library, then lands as the diagram", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { history, flushUntil } = yield* historyWith(
        makeDiagramLibrary(Deferred.await(gate).pipe(Effect.as(BeautifulMermaid))),
      )
      yield* flushUntil("AFTER-DIAGRAM", "400 millis")
      expect(history()).toBe("")
      yield* Deferred.succeed(gate, void 0)
      yield* flushUntil("AFTER-DIAGRAM", "4 seconds")
      expect(history()).toContain("┌")
      expect(history()).not.toContain("graph LR")
      expect(history()).toContain("AFTER-DIAGRAM")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a library that fails to load lets the answer land with its fence as code", () =>
    Effect.gen(function* () {
      const { history, flushUntil } = yield* historyWith(
        makeDiagramLibrary(Effect.fail(new DiagramLibraryError({ cause: "no module" }))),
      )
      yield* flushUntil("AFTER-DIAGRAM", "4 seconds")
      expect(history()).toContain("Alpha-->Beta")
      expect(history()).toContain("AFTER-DIAGRAM")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("an interrupted load is not kept: the next ask loads again", () =>
    Effect.gen(function* () {
      let attempts = 0
      const library = makeDiagramLibrary(
        Effect.suspend(() => {
          attempts += 1
          if (attempts === 1) return Effect.interrupt
          return Effect.succeed(BeautifulMermaid)
        }),
      )
      library.ask()
      yield* Effect.yieldNow.pipe(
        Effect.repeat({ until: () => attempts === 1, schedule: Schedule.spaced("1 millis") }),
      )
      expect(library.failed()).toBe(false)
      expect(Option.isNone(library.loaded())).toBe(true)
      // Each answer that draws asks again; an ask while the first load winds down does nothing.
      yield* Effect.sync(library.ask).pipe(
        Effect.repeat({
          until: () => Option.isSome(library.loaded()),
          schedule: Schedule.spaced("1 millis"),
        }),
      )
      expect(attempts).toBe(2)
    }).pipe(Effect.timeout("4 seconds")),
  )
})

describe("mermaid diagrams", () => {
  it.scopedLive("a diagram draws in place of its fence", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph LR\n  Alpha-->Beta")
      expect(frame).not.toContain("graph LR")
      expect(frame).toContain("Alpha")
      expect(frame).toContain("Beta")
      expect(frame).not.toContain("Alpha-")
      // The edge draws as an arrow into Beta.
      expect(frame).toContain("►")
    }),
  )

  // A node box has no padding inside it, and an edge between two rows of
  // nodes takes one row: two stacked nodes take seven rows.
  it.scopedLive("a diagram draws compact: no padding in a box, one row between nodes", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph TD\n  Alpha-->Beta")
      const rows = diagramRows(frame)
      expect(rows.filter((row) => row.includes("Alpha") || row.includes("Beta"))).toHaveLength(2)
      expect(rows.length).toBeLessThanOrEqual(7)
    }),
  )

  // A diagram does not wrap: one wider than the answer is cut at its right
  // edge, so its row of boxes stays one row.
  it.scopedLive("a diagram wider than the answer is cut, not wrapped", () =>
    Effect.gen(function* () {
      const frame = yield* drawn(
        "graph LR\n  First_node-->Second_node-->Third_node-->Fourth_node",
        40,
      )
      const rows = diagramRows(frame)
      expect(rows.filter((row) => row.includes("┌"))).toHaveLength(1)
      expect(frame).toContain("First_node")
      expect(frame).not.toContain("Fourth_node")
    }),
  )

  it.scopedLive("a hyphen inside an id stays part of the id", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph LR\n  us-east-->db")
      expect(frame).toContain("us-east")
      expect(frame).toContain("db")
    }),
  )

  // Mermaid reads an edge written without spaces as the spaced one. Each
  // drawing names every node, and a labelled edge draws its label.
  const edges: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["Alpha-->Beta", []],
    ["Alpha---Beta", []],
    ["Alpha-.->Beta", []],
    ["Alpha==>Beta", []],
    ["Alpha-->|go|Beta", ["go"]],
    ["Alpha-- go -->Beta", ["go"]],
    ["Alpha-->Beta-->Gamma", ["Gamma"]],
  ]
  for (const [edge, more] of edges) {
    for (const header of ["graph TD", "flowchart LR"]) {
      it.scopedLive(`${header} ${edge} draws every node`, () =>
        Effect.gen(function* () {
          const frame = yield* drawn(`${header}\n  ${edge}`)
          expect(frame).not.toContain(header)
          for (const text of ["Alpha", "Beta", ...more]) expect(frame).toContain(text)
          expect(frame).not.toMatch(/Alpha[-.=]/)
        }),
      )
    }
  }

  // Mermaid reads `;` as a statement separator, after the header too. Each
  // drawing names every node of every statement.
  const statements: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["graph TD;\n  Alpha-->Beta\n  Beta-->Gamma", ["Alpha", "Beta", "Gamma"]],
    ["graph TD\n  Alpha-->Beta; Beta-->Gamma", ["Alpha", "Beta", "Gamma"]],
    ["graph TD\n  Alpha --> Beta; Beta --> Gamma", ["Alpha", "Beta", "Gamma"]],
    ["graph LR; Alpha --> Beta", ["Alpha", "Beta"]],
    ["flowchart LR\n  Alpha-->Beta;", ["Alpha", "Beta"]],
    ['graph LR\n  Alpha["a;b"]-->Beta', ["a;b", "Beta"]],
  ]
  for (const [source, nodes] of statements) {
    it.scopedLive(`${source.replaceAll("\n", " \\n ")} draws every statement`, () =>
      Effect.gen(function* () {
        const frame = yield* drawn(source)
        expect(frame).toContain("┌")
        for (const text of nodes) expect(frame).toContain(text)
      }),
    )
  }

  // A `;` is a separator only between statements. A style value and a
  // comment are not statements: a split there draws their text as nodes.
  const notStatements: ReadonlyArray<readonly [string, string]> = [
    ["graph LR\n  Alpha-->Beta\n  classDef hot fill:#f9f;stroke:#333", "stroke"],
    ["graph LR\n  Alpha-->Beta\n  style Alpha fill:#f9f;stroke:#333", "stroke"],
    ["graph LR\n  Alpha-->Beta\n  linkStyle 0 stroke:#f00;color:red", "color"],
    ["graph LR\n  Alpha-->Beta; style Alpha fill:#f9f;stroke:#333", "stroke"],
    ["graph LR\n  Alpha-->Beta %% note; Gamma-->Delta", "Gamma"],
  ]
  for (const [source, notDrawn] of notStatements) {
    it.scopedLive(`${source.replaceAll("\n", " \\n ")} draws no ${notDrawn} node`, () =>
      Effect.gen(function* () {
        const frame = yield* drawn(source)
        expect(frame).toContain("Alpha")
        expect(frame).toContain("Beta")
        expect(frame).not.toContain(notDrawn)
      }),
    )
  }

  // While the fence streams, a statement is complete once its line ends or
  // a `;` ends it: the diagram draws it before the next line arrives.
  const streamed: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["a line that has ended", "```mermaid\ngraph LR\n  Alpha-->Beta\n", ["Alpha", "Beta"]],
    ["one line of statements ended by `;`", "```mermaid\ngraph LR; Alpha-->Beta;", ["Beta"]],
    [
      "a `;` after the last statement",
      "```mermaid\ngraph LR\n  Alpha-->Beta; Beta-->Gamma;",
      ["Gamma"],
    ],
  ]
  for (const [name, content, nodes] of streamed) {
    it.scopedLive(`an open fence draws ${name}`, () =>
      Effect.gen(function* () {
        const frame = yield* drawnAnswer(content)
        for (const text of nodes) expect(frame).toContain(text)
      }),
    )
  }

  // Only an edge statement is an edge: a subgraph title keeps its text.
  it.scopedLive("a subgraph title stays as written", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph LR\n  subgraph a-->b\n    Alpha-->Beta\n  end")
      expect(frame).toContain("a-->b")
      expect(frame).toContain("Alpha")
      expect(frame).toContain("Beta")
    }),
  )

  it.scopedLive("an arrow inside a label stays as written", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph LR\n  Alpha[a-->b]-->Beta")
      expect(frame).toContain("a-->b")
      expect(frame).toContain("Beta")
    }),
  )

  // The diagram is its own block: markdown never reads its text, so a
  // backtick or a star in a label draws as written.
  it.scopedLive("a label keeps its backticks and stars", () =>
    Effect.gen(function* () {
      const frame = yield* drawn("graph LR\n  Alpha[`tick` and *star*]-->Beta")
      expect(frame).toContain("`tick`")
    }),
  )
})
