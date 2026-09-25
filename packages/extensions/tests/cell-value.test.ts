import { describe, expect, test } from "effect-bun-test"
import { Option, Schema } from "effect"
import { inspect } from "node:util"
import { runInThisContext } from "node:vm"
import { displayValue, type PromiseState } from "../src/cell-value.js"

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
      ["a string with a single quote", "it's"],
      ["a string with both quotes", "it's \\"so\\""],
      ["a string with every quote", "it's \\"so\\" \`x\`"],
      ["control characters", "a\\tb\\u0001c\\u007f"],
      ["a lone surrogate and a pair", "x\\ud800y\\ud83d\\ude00"],
      ["a symbol", Symbol("s")],
      ["undefined", undefined],
      ["null", null],
      ["a boolean", true],
      ["nested arrays", [1, "two", [3, [4, [5, [6]]]]]],
      ["an empty array", []],
      ["a sparse array", [1, , 3]],
      ["a long sparse array", Object.assign([1, 2, 3, 4, 5], { length: 300 })],
      ["a long array", Array.from({ length: 120 }, (_, index) => index)],
      ["a numeric array", Array.from({ length: 27 }, (_, index) => index + 1)],
      ["a string array", ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]],
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
      ["a long typed array", new Uint8Array(150)],
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

  for (const [name, value, expected] of differentValues)
    test(`${name} shows without running cell code`, () => {
      expect(shown(value)).toContain(expected)
    })

  test("a getter and a trap never run", () => {
    for (const [value, expected] of hazards) expect(shown(value)).toBe(expected)
    expect(Reflect.get(globalThis, "displayRan")).toBeUndefined()
  })
})
