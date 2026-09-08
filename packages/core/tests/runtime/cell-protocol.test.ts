import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import {
  CellRequest,
  CellResponse,
  decodeCellRequest,
  decodeCellResponse,
  encodeCellRequest,
  encodeCellResponse,
  makeCellFrameReader,
  maximumCellFrameBytes,
  cellOutputBoundary,
  makeCellOutputScanner,
} from "@gent/core-internal/runtime/code-cell/cell-protocol"

describe("cell process protocol", () => {
  it.live("preserves a Unicode request split across pipe reads", () =>
    Effect.gen(function* () {
      const request = CellRequest.cases.Evaluate.make({ cellId: "cell-1", source: "'你好'" })
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
        const scanner = makeCellOutputScanner()
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
      const scanner = makeCellOutputScanner()
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
})
