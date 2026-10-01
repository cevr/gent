import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Config, Effect, Option, Path, Schema } from "effect"
import { createMermaidCache, extractMermaidBlocks, replaceMermaidBlocks } from "../src/mermaid"
import { textWidth } from "../src/bun-adapter"

// ── mermaid blocks ──────────────────────────────────────────────────────────

describe("extractMermaidBlocks", () => {
  test("extracts single block with correct source/startIndex/endIndex", () => {
    const text = "before\n```mermaid\ngraph TD\n  A-->B\n```\nafter"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.source).toBe("graph TD\n  A-->B")
    expect(blocks[0]!.startIndex).toBe(7)
    expect(blocks[0]!.endIndex).toBe(text.indexOf("```\n") + 3)
  })

  test("extracts multiple blocks", () => {
    const text = [
      "intro",
      "```mermaid",
      "graph LR",
      "  A-->B",
      "```",
      "middle",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: msg",
      "```",
      "end",
    ].join("\n")
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(2)
    expect(blocks[0]!.source).toBe("graph LR\n  A-->B")
    expect(blocks[1]!.source).toBe("sequenceDiagram\n  A->>B: msg")
  })

  test("returns [] for no mermaid blocks", () => {
    expect(extractMermaidBlocks("no mermaid here")).toEqual([])
    expect(extractMermaidBlocks("```typescript\nconst x = 1\n```")).toEqual([])
  })

  test("skips empty mermaid blocks", () => {
    const text = "```mermaid\n\n```"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(0)
  })

  test("handles whitespace before content", () => {
    const text = "```mermaid\n  \n  graph TD\n    A-->B\n```"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.source).toBe("graph TD\n    A-->B")
  })

  test("correct indices for replaceMermaidBlocks composition", () => {
    const prefix = "Hello\n"
    const mermaid = "```mermaid\ngraph TD\n  A-->B\n```"
    const suffix = "\nGoodbye"
    const text = prefix + mermaid + suffix

    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.startIndex).toBe(prefix.length)
    expect(blocks[0]!.endIndex).toBe(prefix.length + mermaid.length)
    // Verify slicing roundtrip
    expect(text.slice(blocks[0]!.startIndex, blocks[0]!.endIndex)).toBe(mermaid)
  })
})

describe("inline mermaid replace", () => {
  const diagram = "before\n```mermaid\ngraph LR\n  Alpha-->Beta\n```\nafter"
  const uncached = replaceMermaidBlocks(Option.none())

  const widest = (text: string): number => Math.max(...text.split("\n").map((line) => line.length))

  test("a diagram is drawn in place of its code block, inside the width", () => {
    const drawn = uncached(diagram, 80)
    expect(drawn.startsWith("before\n")).toBe(true)
    expect(drawn.endsWith("\nafter")).toBe(true)
    expect(drawn).not.toContain("```mermaid")
    expect(drawn).toContain("Alpha")
    expect(drawn).toContain("Beta")
    expect(drawn).not.toContain("Alpha-")
    // The edge draws as an arrow into Beta.
    expect(drawn).toContain("►")
    expect(widest(drawn)).toBeLessThanOrEqual(80)
  })

  test("a hyphen inside an id stays part of the id", () => {
    const drawn = uncached("```mermaid\ngraph LR\n  us-east-->db\n```", 120)
    expect(drawn).toContain("us-east")
    expect(drawn).toContain("db")
  })

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
      test(`${header} ${edge} draws every node`, () => {
        const drawn = uncached(`\`\`\`mermaid\n${header}\n  ${edge}\n\`\`\``, 120)
        expect(drawn).not.toContain("```mermaid")
        for (const text of ["Alpha", "Beta", ...more]) expect(drawn).toContain(text)
        expect(drawn).not.toMatch(/Alpha[-.=]/)
      })
    }
  }

  // Only an edge statement is an edge: a subgraph title keeps its text.
  test("a subgraph title stays as written", () => {
    const drawn = uncached(
      "```mermaid\ngraph LR\n  subgraph a-->b\n    Alpha-->Beta\n  end\n```",
      120,
    )
    expect(drawn).toContain("a-->b")
    expect(drawn).toContain("Alpha")
    expect(drawn).toContain("Beta")
  })

  test("an arrow inside a label stays as written", () => {
    const drawn = uncached("```mermaid\ngraph LR\n  Alpha[a-->b]-->Beta\n```", 120)
    expect(drawn).toContain("a-->b")
    expect(drawn).toContain("Beta")
  })

  // A CJK label takes two columns a character: the fit counts columns, not
  // code units, so the drawing chosen fits the terminal.
  test("a diagram with wide labels is fitted by the columns it takes", () => {
    const wide = "```mermaid\ngraph LR\n  A[甲乙丙丁戊己庚辛]-->B[壬癸子丑寅卯辰巳]\n```"
    const drawn = uncached(wide, 45)
    expect(drawn).not.toContain("```mermaid")
    expect(Math.max(...drawn.split("\n").map((line) => textWidth(line)))).toBeLessThanOrEqual(45)
  })

  test("a width no preset fits keeps the tightest drawing", () => {
    const narrow = uncached(diagram, 4)
    expect(narrow).not.toContain("```mermaid")
    expect(widest(narrow)).toBeLessThan(widest(uncached(diagram, 200)))
  })

  /** A string as a JavaScript string literal, for the child process's code. */
  const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String))

  // beautiful-mermaid colors its drawing when stdout is a color terminal, as
  // the TUI's is. The transcript draws text, not escape codes, so the drawing
  // stays plain whatever the terminal. The terminal is process-wide, so the
  // drawing runs in a child process whose stdout reads as a color terminal.
  it.scopedLive("a diagram drawn on a color terminal holds no escape codes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const module = path.resolve(import.meta.dir, "../src/mermaid.ts")
      const diagram = "```mermaid\ngraph TD\n  A-->B\n  A-->C\n```"
      const draw = [
        "Object.assign(process.stdout, { isTTY: true })",
        `const { replaceMermaidBlocks } = await import(${literal(module)})`,
        'const { Option } = await import("effect")',
        `process.stdout.write(replaceMermaidBlocks(Option.none())(${literal(diagram)}, 80))`,
      ].join("\n")
      const searchPath = yield* Config.String("PATH")
      // eslint-disable-next-line effect/noGlobals -- the color terminal is process-wide, so the child process is the boundary under test.
      const child = Bun.spawn(["bun", "-e", draw], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { PATH: searchPath, COLORTERM: "truecolor", TERM: "xterm-256color" },
        stdout: "pipe",
      })
      const drawn = yield* Effect.promise(() => new Response(child.stdout).text()).pipe(
        Effect.timeout("10 seconds"),
      )
      expect(drawn).not.toContain("\x1b")
      expect(drawn).toContain("│  C  │")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  test("a source that does not parse stays as its code block", () => {
    const broken = "```mermaid\nnot a diagram {{{\n```"
    expect(uncached(broken, 80)).toBe(broken)
  })

  test("the session view's cache serves a second draw of the same diagram", () => {
    const cache = createMermaidCache()
    const cached = replaceMermaidBlocks(Option.some(cache))
    const first = cached(diagram, 80)
    expect(first).toBe(uncached(diagram, 80))
    expect(cache.renders.size).toBe(1)
    expect(cached(diagram, 80)).toBe(first)
    expect(cache.renders.size).toBe(1)
    cached(diagram, 60)
    expect(cache.renders.size).toBe(2)
  })
})
