/* oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- This test drives the vm realm boundary directly. */
import { describe, expect, test } from "effect-bun-test"
import { Schema } from "effect"
import { createContext, runInContext } from "node:vm"
import {
  encodeSnapshot,
  maximumSnapshotBindingBytes,
  type SnapshotBinding,
  snapshotReviverSource,
} from "@gent/core-internal/runtime/code-cell/cell-snapshot"

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
})
