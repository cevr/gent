import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import {
  cellOutputBoundary,
  CellRequest,
  CellResponse,
  decodeCellRequest,
  decodeCellResponse,
  encodeCellRequest,
  encodeCellResponse,
  encodeSnapshot,
  makeBoundedOutput,
  makeCellFrameReader,
  makeCellOutputScanner,
  maximumCellFrameBytes,
  maximumSnapshotBindingBytes,
  type SnapshotBinding,
  snapshotReviverSource,
} from "../src/cell-protocol.js"
import { createContext, runInContext } from "node:vm"

describe("cell process protocol", () => {
  it.live("preserves a Unicode request split across pipe reads", () =>
    Effect.gen(function* () {
      const request = CellRequest.cases.Evaluate.make({
        cellId: "cell-1",
        outputToken: "cell-1-token",
        source: "'你好'",
      })
      const bytes = yield* encodeCellRequest(request)
      const reader = makeCellFrameReader()
      const frames: string[] = []
      for (const byte of bytes) {
        frames.push(...(yield* reader.push(new Uint8Array([byte]))))
      }
      expect(frames.length).toBe(1)
      expect(yield* decodeCellRequest(frames.join(""))).toEqual(request)
      yield* reader.end
    }),
  )

  it.live("reads coalesced replies in order", () =>
    Effect.gen(function* () {
      const ready = CellResponse.cases.Ready.make({ version: 1 })
      const reset = CellResponse.cases.Reset.make({ requestId: "reset-1" })
      const first = yield* encodeCellResponse(ready)
      const second = yield* encodeCellResponse(reset)
      const reader = makeCellFrameReader()
      const frames = yield* reader.push(new Uint8Array([...first, ...second]))
      expect(yield* Effect.forEach(frames, decodeCellResponse)).toEqual([ready, reset])
    }),
  )

  it.live("rejects an oversized unfinished frame before decoding JSON", () =>
    Effect.gen(function* () {
      const reader = makeCellFrameReader()
      yield* reader.push(new Uint8Array(maximumCellFrameBytes).fill(32))
      const error = yield* reader.push(new Uint8Array([32])).pipe(Effect.flip)
      expect(error.message).toContain("byte limit")
    }),
  )

  it.live("rejects truncated frames and invalid UTF-8", () =>
    Effect.gen(function* () {
      const reader = makeCellFrameReader()
      yield* reader.push(new Uint8Array([123]))
      expect((yield* reader.end.pipe(Effect.flip)).message).toContain("during a frame")
      const invalid = makeCellFrameReader()
      expect((yield* invalid.push(new Uint8Array([255, 10])).pipe(Effect.flip))._tag).toBe(
        "CellProtocolError",
      )
    }),
  )

  it.live("limits encoded bytes rather than JavaScript string length", () =>
    Effect.gen(function* () {
      const response = CellResponse.cases.HostCall.make({
        cellId: "cell-1",
        operationId: "op-1",
        name: "write",
        input: "你".repeat(Math.ceil(maximumCellFrameBytes / 3)),
      })
      const error = yield* encodeCellResponse(response).pipe(Effect.flip)
      expect(error.message).toContain("byte limit")
    }),
  )

  it.live(
    "cell output boundaries close the text before them even when a chunk splits the marker",
    () =>
      Effect.sync(() => {
        const scanner = makeCellOutputScanner(() => Option.some("cell-1"))
        const marker = cellOutputBoundary("cell-1")
        const first = scanner.push(`before ${marker.slice(0, 5)}`)
        expect(first).toEqual([{ text: "before ", boundary: Option.none() }])
        const second = scanner.push(`${marker.slice(5)}after`)
        expect(second).toEqual([
          { text: "", boundary: Option.some("cell-1") },
          { text: "after", boundary: Option.none() },
        ])
      }),
  )

  it.live("stray record separators in cell output stay text", () =>
    Effect.sync(() => {
      const scanner = makeCellOutputScanner(() => Option.some("x"))
      expect(scanner.push("a\u001eb\u001ec")).toEqual([
        { text: "a\u001eb", boundary: Option.none() },
      ])
      expect(scanner.push(`${cellOutputBoundary("x")}`)).toEqual([
        { text: "\u001ec", boundary: Option.some("x") },
      ])
      const long = `\u001e${"z".repeat(400)}`
      expect(scanner.push(long)).toEqual([{ text: long, boundary: Option.none() }])
    }),
  )

  it.live("a boundary with another token, an empty token, or an oversized token stays text", () =>
    Effect.sync(() => {
      const flush = (candidate: string) => {
        const scanner = makeCellOutputScanner(() => Option.some("real"))
        const segments = scanner.push(`${candidate}tail`)
        return segments.map((segment) => segment.text).join("") + scanner.end()
      }
      const forged = cellOutputBoundary("forged")
      expect(flush(forged)).toBe(`${forged}tail`)
      const empty = cellOutputBoundary("")
      expect(flush(empty)).toBe(`${empty}tail`)
      const oversized = cellOutputBoundary("r".repeat(129))
      expect(flush(oversized)).toBe(`${oversized}tail`)
      const scanner = makeCellOutputScanner(() => Option.some("real"))
      expect(scanner.push(cellOutputBoundary("real"))).toEqual([
        { text: "", boundary: Option.some("real") },
      ])
    }),
  )

  it.live("closing the stream releases a held partial boundary as text", () =>
    Effect.sync(() => {
      const scanner = makeCellOutputScanner(() => Option.some("x"))
      expect(scanner.push("done\u001egent-cell")).toEqual([
        { text: "done", boundary: Option.none() },
      ])
      expect(scanner.end()).toBe("\u001egent-cell")
      expect(scanner.end()).toBe("")
    }),
  )
})

describe("bounded output", () => {
  test("text that fits the limit comes back whole, with no omission notice", () => {
    const exact = makeBoundedOutput({ limit: 4, headLimit: 2 })
    exact.append("abcd")
    expect(exact.read()).toBe("abcd")
    expect(exact.truncated()).toBe(false)
  })
  test("one character past the limit drops one character and says so", () => {
    const over = makeBoundedOutput({ limit: 4, headLimit: 2 })
    over.append("abcde")
    expect(over.read()).toBe("ab\n... [1 characters omitted] ...\nde")
    expect(over.truncated()).toBe(true)
  })
  test("the count covers text dropped across appends, and take resets it", () => {
    const many = makeBoundedOutput({ limit: 4, headLimit: 2 })
    many.append("abc")
    many.append("defg")
    expect(many.take()).toBe("ab\n... [3 characters omitted] ...\nfg")
    expect(many.read()).toBe("")
    expect(many.truncated()).toBe(false)
  })
})

// ── cell snapshot ───────────────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
type Context = ReturnType<typeof createContext>

const restoreInto = (context: Context, bindings: ReadonlyArray<SnapshotBinding>) => {
  const revive = runInContext(snapshotReviverSource, context)
  for (const binding of bindings) {
    Object.defineProperty(context, binding.name, {
      value: revive(encodeJson(binding.value)),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
}

describe("cell namespace snapshot", () => {
  test("data bindings round-trip into a vm context with that context's intrinsics", () => {
    const source = createContext({})
    runInContext(
      [
        "var n = 42; var s = 'text'; var nothing = undefined; var nan = NaN; var big = 10n;",
        "var when = new Date(86400000); var re = /a+/gi; var err = new RangeError('boom');",
        "var m = new Map([['k', { nested: [1, 2, 3] }]]); var set = new Set([1, 'two']);",
        "var bytes = new Uint8Array([1, 2, 3]); var floats = new Float64Array([1.5]);",
        "var plain = { a: { b: null }, '$gent': 'literal key' };",
      ].join("\n"),
      source,
    )
    const namespace = new Map(Object.entries(source))
    const snapshot = encodeSnapshot(namespace)
    expect(snapshot.omitted).toEqual([])
    expect(snapshot.bindings.map((binding) => binding.name)).toEqual([...namespace.keys()])

    const target = createContext({})
    restoreInto(target, snapshot.bindings)
    const probe = runInContext(
      [
        "[n, s, nothing === undefined, Number.isNaN(nan), big === 10n,",
        " when instanceof Date && when.getTime(), re instanceof RegExp && re.flags,",
        " err instanceof Error && err.name + ':' + err.message,",
        " m instanceof Map && m.get('k').nested.join(','), set instanceof Set && set.has('two'),",
        " bytes instanceof Uint8Array && Array.from(bytes).join(','), floats[0],",
        " plain.a.b === null && plain['$gent']]",
      ].join(""),
      target,
    )
    expect(probe).toEqual([
      42,
      "text",
      true,
      true,
      true,
      86400000,
      "gi",
      "RangeError:boom",
      "1,2,3",
      true,
      "1,2,3",
      1.5,
      "literal key",
    ])
  })

  test("an own __proto__ key round-trips as a key, not as the prototype", () => {
    const source = createContext({})
    runInContext(
      "var parsed = JSON.parse('{\"__proto__\": {\"x\": 1}, \"a\": 2}'); var wrapped = { '$gent': 'k', inner: parsed };",
      source,
    )
    const snapshot = encodeSnapshot(new Map(Object.entries(source)))
    expect(snapshot.omitted).toEqual([])
    const target = createContext({})
    restoreInto(target, snapshot.bindings)
    const probe = runInContext(
      [
        "[Object.keys(parsed).join(','), parsed['__proto__'].x, Object.getPrototypeOf(parsed) === Object.prototype,",
        " Object.keys(wrapped.inner).join(','), wrapped.inner['__proto__'].x]",
      ].join(""),
      target,
    )
    expect(probe).toEqual(["__proto__,a", 1, true, "__proto__,a", 1])
  })

  test("functions, class instances, cycles, and oversized values are named, not dropped silently", () => {
    interface Loop {
      self?: Loop
    }
    const cyclic: Loop = {}
    cyclic.self = cyclic
    class Custom {
      readonly value = 1
    }
    const namespace = new Map<string, unknown>([
      ["fn", () => 1],
      ["instance", new Custom()],
      ["loop", cyclic],
      ["huge", "x".repeat(maximumSnapshotBindingBytes + 1)],
      ["kept", [1, 2]],
    ])
    const snapshot = encodeSnapshot(namespace)
    expect(snapshot.bindings.map((binding) => binding.name)).toEqual(["kept"])
    expect(snapshot.omitted).toEqual([
      { name: "fn", reason: "function" },
      { name: "instance", reason: "unsupported" },
      { name: "loop", reason: "cyclic" },
      { name: "huge", reason: "too-large" },
    ])
  })

  // The size is the UTF-8 length of the JSON text, counted without a TextEncoder.
  test("a binding fits by the UTF-8 bytes of its JSON text, escapes included", () => {
    const limit = maximumSnapshotBindingBytes
    // Two quotes; "é" is 2 bytes, an emoji 4, a JSON-escaped quote 2, a lone surrogate 6.
    const fits: ReadonlyArray<readonly [string, string]> = [
      ["two-byte", "é".repeat((limit - 2) / 2)],
      ["four-byte", `${"😀".repeat((limit - 4) / 4)}é`],
      ["escaped", '"'.repeat((limit - 2) / 2)],
      ["surrogate", `${"\ud800".repeat(43_690)}é`],
    ]
    for (const [name, text] of fits) {
      const inside = encodeSnapshot(new Map([[name, text]]))
      expect(inside.bindings.map((binding) => binding.name)).toEqual([name])
      const over = encodeSnapshot(new Map([[name, `${text}a`]]))
      expect(over.omitted).toEqual([{ name, reason: "too-large" }])
    }
  })
})
