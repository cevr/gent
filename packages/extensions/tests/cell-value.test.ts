import { describe, expect, it, test } from "effect-bun-test"
import { Duration, Effect, Option, Schema } from "effect"
import { inspect } from "node:util"
import { createContext, runInContext, runInThisContext } from "node:vm"
import { type SnapshotBinding, snapshotReviverSource } from "../src/cell-protocol.js"
import {
  displayValue,
  encodeSnapshot,
  maximumSnapshotBindingBytes,
  type PromiseState,
} from "../src/cell-value.js"

// ── value display ───────────────────────────────────────────────────────────

/** The options the worker gave `inspect` before the display replaced it. */
// oxlint-disable-next-line effect/noUnknownParameters -- the display takes any JavaScript value
const inspected = (value: unknown) =>
  inspect(value, {
    depth: 4,
    maxArrayLength: 100,
    maxStringLength: 8192,
    customInspect: false,
    getters: false,
  })

const peek = Bun.peek
// oxlint-disable-next-line effect/noObjectParameters -- a promise has any JavaScript shape
const promiseState = (promise: object): Option.Option<PromiseState> => {
  const status = peek.status(promise)
  if (status === "pending") return Option.some({ status, value: promise })
  return Option.some({ status, value: peek(promise) })
}
// oxlint-disable-next-line effect/noUnknownParameters -- the display takes any JavaScript value
const shown = (value: unknown) => displayValue(value, { promiseState })

/**
 * Cell-shaped values are written as the JavaScript a cell would run, in this
 * realm, so each keeps the shape a cell gives it.
 */
const ordinaryValues = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
)(
  runInThisContext(`(() => {
    class Custom { value = 1 }
    class Base {}
    class Derived extends Base {}
    class WithStatic { static count = 2 }
    const cyclic = { a: 1 }
    cyclic.self = cyclic
    const nullPrototype = Object.create(null)
    nullPrototype.a = 1
    const argumentsOf = function () { return arguments }
    return [
      ["a number", 42],
      ["negative zero", -0],
      ["NaN", NaN],
      ["a bigint", 10n],
      ["a string", "text"],
      ["a string with every quote", "it's \\"so\\" \`x\`"],
      ["control characters", "a\\tb\\u0001c\\u007f"],
      ["a lone surrogate and a pair", "x\\ud800y\\ud83d\\ude00"],
      ["a symbol", Symbol("s")],
      ["undefined", undefined],
      ["null", null],
      ["a boolean", true],
      ["an empty array", []],
      ["a sparse array", [1, , 3]],
      ["a long sparse array", Object.assign([1, 2, 3, 4, 5], { length: 300 })],
      ["an array with an extra key", Object.assign([1, 2], { note: "extra" })],
      ["a deep object", { a: 1, b: "x", c: { d: { e: { f: { g: 1 } } } } }],
      ["an empty object", {}],
      ["quoted keys", { "a-b": 1, $ok: 2, 3: 3, ["__proto__"]: 4 }],
      ["a symbol key", { [Symbol("k")]: 1 }],
      ["a null prototype", nullPrototype],
      ["a class instance", new Custom()],
      ["accessors", { get g() { return 1 }, set s(v) {}, get gs() { return 1 }, set gs(v) {} }],
      ["a named function", function named() {}],
      ["an arrow function", () => 1],
      ["an anonymous function", [function () {}][0]],
      ["an async function", async function af() {}],
      ["a generator function", function* gf() {}],
      ["a class", Custom],
      ["a derived class", Derived],
      ["a class with a static field", WithStatic],
      ["a date", new Date(86400000)],
      ["an invalid date", new Date(NaN)],
      ["a regular expression", /a+/gi],
      ["a map", new Map([["k", { nested: [1, 2] }], [1, "one"]])],
      ["a set", new Set([1, "two"])],
      ["an empty map", new Map()],
      ["nested maps", new Map([["a", new Map([["b", new Map([["c", new Map([["d", new Map()]])]])]])]])],
      ["a typed array", new Uint8Array([1, 2, 3])],
      ["a buffer", Buffer.from([1, 2])],
      ["a float array", new Float64Array([1.5])],
      ["a bigint array", new BigInt64Array([1n])],
      ["a cycle", cyclic],
      ["a resolved promise", Promise.resolve(1)],
      ["a pending promise", new Promise(() => {})],
      ["a wide object", { alpha: "aaaaaaaaaaaaaaaa", beta: "bbbbbbbbbbbbbbbbbbb", gamma: "cccccccccccccccccc", delta: 4 }],
      ["objects in an array", [{ a: 1 }, { b: 2 }]],
      ["a boxed string", new String("x")],
      ["a boxed number", new Number(3)],
      ["a weak map", new WeakMap()],
      ["an array buffer", new ArrayBuffer(2)],
      ["a multiline string in an array", ["a\\nb"]],
      ["a long multiline string", { text: "first line of text\\nsecond line of text\\nthird line of text\\nfourth line" }],
      ["a long string", "x".repeat(9000)],
      ["a URL", new URL("https://example.com/a")],
      ["an arguments object", argumentsOf(1, 2)],
    ]
  })()`),
)

/**
 * Values the display lays out more plainly than `inspect`: strings always take
 * single quotes, and a list packs its items onto lines instead of aligned columns.
 */
const plainLayoutValues = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown, Schema.String])),
)(
  runInThisContext(`[
    ["a string with a single quote", "it's", "'it\\\\'s'"],
    ["a string with both quotes", "it's \\"so\\"", "'it\\\\'s \\"so\\"'"],
    ["nested arrays", [1, "two", [3, [4, [5, [6]]]]], "[\\n  1,\\n  'two',\\n  [\\n    3, [ 4, [ 5, [ 6 ] ] ]\\n  ]\\n]"],
    ["a numeric array", Array.from({ length: 27 }, (_, index) => index + 1), "[\\n  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,\\n  23, 24, 25, 26, 27\\n]"],
    ["a string array", ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"], "[\\n  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'\\n]"],
  ]`),
)

/** Long lists show their first hundred items, then a count of the rest. */
const longLists = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown, Schema.String, Schema.String])),
)(
  runInThisContext(`[
    ["a long array", Array.from({ length: 120 }, (_, index) => index), "[\\n  0, 1, 2, 3,", "98, 99, ... 20 more items\\n]"],
    ["a long typed array", new Uint8Array(150), "Uint8Array(150) [\\n  0, 0,", " ... 50 more items\\n]"],
  ]`),
)

/** What the display shows where `inspect` would run cell code or print more than a model needs. */
const differentValues = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown, Schema.String])),
)(
  runInThisContext(`[
    // inspect shows a Proxy's target, which it reads through the traps.
    ["a Proxy", new Proxy({ a: 1 }, {}), "[Proxy]"],
    // inspect shows an error's stack, which lists the worker's frames.
    ["a nested error", { e: new RangeError("inner") }, "{ e: [RangeError: inner] }"],
    // inspect lists every property.
    [
      "an object with more than 100 properties",
      Object.fromEntries(Array.from({ length: 102 }, (_, index) => ["k" + index, index])),
      "... 2 more properties",
    ],
  ]`),
)

/** Values whose getters and traps record that they ran. */
const hazards = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.Unknown, Schema.String])),
)(
  runInThisContext(`[
    [{ get [Symbol.toStringTag]() { globalThis.displayRan = true; return "Tag" } }, "{ Symbol(Symbol.toStringTag): [Getter] }"],
    [Object.create(new Proxy({}, { getPrototypeOf() { globalThis.displayRan = true; return null } })), "[Object: unreadable prototype] {}"],
  ]`),
)

describe("cell value display", () => {
  for (const [name, value] of ordinaryValues)
    test(`${name} shows as inspect shows it`, () => {
      expect(shown(value)).toBe(inspected(value))
    })

  for (const [name, value, expected] of plainLayoutValues)
    test(`${name} shows in the plain layout`, () => {
      expect(shown(value)).toBe(expected)
    })

  for (const [name, value, head, tail] of longLists)
    test(`${name} shows its first hundred items on packed lines`, () => {
      const display = shown(value)
      expect(display.startsWith(head)).toBe(true)
      expect(display.endsWith(tail)).toBe(true)
      for (const line of display.split("\n")) expect(line.length).toBeLessThanOrEqual(80)
    })

  for (const [name, value, expected] of differentValues)
    test(`${name} shows without running cell code`, () => {
      expect(shown(value)).toContain(expected)
    })

  test("a getter and a trap never run", () => {
    for (const [value, expected] of hazards) expect(shown(value)).toBe(expected)
    expect(Reflect.get(globalThis, "displayRan")).toBeUndefined()
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

  // The encoder stops once a binding's byte budget is spent, so a large value is never read to its end.
  it.live("a 5 MB string and a 100k array stop at the byte budget", () =>
    Effect.gen(function* () {
      const namespace = new Map<string, unknown>([
        ["text", "x".repeat(5 * 1024 * 1024)],
        // The Proxy at the end is unsupported: only an encoder that reads every item reaches it.
        ["items", [...Array.from({ length: 100_000 }, (_, index) => index), new Proxy({}, {})]],
        ["kept", 1],
      ])
      const [elapsed, snapshot] = yield* Effect.timed(Effect.sync(() => encodeSnapshot(namespace)))
      expect(Duration.toMillis(elapsed)).toBeLessThan(1000)
      expect(snapshot.bindings.map((binding) => binding.name)).toEqual(["kept"])
      expect(snapshot.omitted).toEqual([
        { name: "text", reason: "too-large" },
        { name: "items", reason: "too-large" },
      ])
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The size is the UTF-8 length of the JSON text, from the native byte count saved at load.
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
