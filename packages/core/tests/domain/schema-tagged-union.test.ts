/**
 * `Schema.TaggedUnion` regression locks.
 *
 * Exercises upstream `Schema.TaggedUnion` / `Schema.TaggedStruct` +
 * `Schema.toTaggedUnion` directly — the invariants production call
 * sites rely on at the schema layer.
 *
 * Covered invariants:
 * - per-variant TaggedStruct identity (`Schema.is` narrows to a single case)
 * - constructor surface (`Enum.cases.Member.make({...})`)
 * - decode/encode round-trip at the union level
 * - `guards` validate the full payload (composed `Schema.is` per variant)
 * - `isAnyOf` and `match` dispatch on `_tag` ONLY (no payload validation) —
 *   regression-locked explicitly so future readers know not to feed untrusted
 *   values through them. Production callers only invoke these on values that
 *   already passed `Schema.decodeUnknownSync(...)` at the wire boundary, or
 *   that were constructed in-process via `cases.X.make(...)`.
 * - explicit wire-tag preservation via `Schema.TaggedStruct("wire-tag", ...)`
 *   unioned with `Schema.toTaggedUnion("_tag")`
 * - single-variant edge case
 * - per-enum identifier namespacing (distinct AST identity)
 * - Effect-friendly decode (no service requirements)
 *
 * @module
 */
import { describe, test, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentEvent } from "@gent/core-internal/domain/event"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"

describe("Schema.TaggedUnion — basic shape", () => {
  const Shape = Schema.TaggedUnion({
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  test("cases bag exposes a TaggedStruct per member", () => {
    expect(typeof Shape.cases.Circle).toBe("object")
    expect(typeof Shape.cases.Rectangle).toBe("object")
    expect(typeof Shape.cases.Circle.make).toBe("function")
  })
  test("`cases.Variant.make(...)` constructs a value with the right `_tag`", () => {
    const c = Shape.cases.Circle.make({ radius: 5 })
    expect(c._tag).toBe("Circle")
    expect(c.radius).toBe(5)
  })
  test("schema guards work on directly-constructed variants", () => {
    const c = Shape.cases.Circle.make({ radius: 5 })
    const r = Shape.cases.Rectangle.make({ width: 3, height: 4 })
    expect(Schema.is(Shape.cases.Circle)(c)).toBe(true)
    expect(Schema.is(Shape.cases.Rectangle)(r)).toBe(true)
    expect(Schema.is(Shape.cases.Rectangle)(c)).toBe(false)
  })
})

describe("Schema.TaggedUnion — decode/encode round-trip", () => {
  const Shape = Schema.TaggedUnion({
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  test("decode produces well-shaped values", () => {
    const decoded = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 5 })
    expect(decoded._tag).toBe("Circle")
    if (decoded._tag === "Circle") {
      expect(decoded.radius).toBe(5)
    }
  })
  test("encode round-trips back to wire format", () => {
    const c = Shape.cases.Circle.make({ radius: 5 })
    const encoded = Schema.encodeUnknownSync(Shape)(c)
    expect(encoded).toEqual({ _tag: "Circle", radius: 5 })
  })
  test("decode rejects unknown `_tag`", () => {
    expect(() => Schema.decodeUnknownSync(Shape)({ _tag: "Unknown", radius: 5 })).toThrow()
  })
  test("decode rejects malformed payload", () => {
    expect(() =>
      Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: "not a number" }),
    ).toThrow()
  })
})

describe("Schema.TaggedUnion — match / guards / isAnyOf", () => {
  const Shape = Schema.TaggedUnion({
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
    Triangle: { base: Schema.Number, height: Schema.Number },
  })
  type Shape = Schema.Schema.Type<typeof Shape>
  test("`match` is exhaustive by member name", () => {
    const area = (s: Shape) =>
      Shape.match({
        Circle: (c) => Math.PI * c.radius ** 2,
        Rectangle: (r) => r.width * r.height,
        Triangle: (t) => (t.base * t.height) / 2,
      })(s)
    expect(area(Shape.cases.Circle.make({ radius: 1 }))).toBeCloseTo(Math.PI)
    expect(area(Shape.cases.Rectangle.make({ width: 3, height: 4 }))).toBe(12)
    expect(area(Shape.cases.Triangle.make({ base: 4, height: 6 }))).toBe(12)
  })
  test("`guards` narrow per member", () => {
    const c = Shape.cases.Circle.make({ radius: 5 })
    const r = Shape.cases.Rectangle.make({ width: 1, height: 2 })
    expect(Shape.guards.Circle(c)).toBe(true)
    expect(Shape.guards.Circle(r)).toBe(false)
    expect(Shape.guards.Rectangle(r)).toBe(true)
    expect(Shape.guards.Rectangle(c)).toBe(false)
  })
  test("`isAnyOf` checks subset membership by member name", () => {
    const c = Shape.cases.Circle.make({ radius: 5 })
    const r = Shape.cases.Rectangle.make({ width: 1, height: 2 })
    const t = Shape.cases.Triangle.make({ base: 1, height: 1 })
    const round = Shape.isAnyOf(["Circle"])
    const angular = Shape.isAnyOf(["Rectangle", "Triangle"])
    expect(round(c)).toBe(true)
    expect(round(r)).toBe(false)
    expect(angular(r)).toBe(true)
    expect(angular(t)).toBe(true)
    expect(angular(c)).toBe(false)
  })
})

describe("Schema.TaggedUnion — runtime-helper payload-validation semantics", () => {
  const Shape = Schema.TaggedUnion({
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  type Shape = Schema.Schema.Type<typeof Shape>
  // A spoof value: right `_tag`, wrong payload shape. Constructed via
  // `as unknown as Shape` to bypass the type system — exactly the kind of
  // value a wire-boundary failure or a hostile decode would produce.
  const spoof = { _tag: "Circle", radius: "not a number" } as unknown as Shape
  test("`guards.X` validates the full payload — spoofed payload is rejected", () => {
    // `guards.X` is `Schema.is(case)` per variant in upstream, so the payload
    // shape is checked, not just the discriminator.
    expect(Shape.guards.Circle(spoof)).toBe(false)
  })
  test("`isAnyOf` is tag-only — spoofed payload is accepted", () => {
    // Regression-lock: `isAnyOf` matches against `_tag` only. Production
    // callers do not feed untrusted values through `isAnyOf`.
    expect(Shape.isAnyOf(["Circle"])(spoof)).toBe(true)
  })
  test("`match` is tag-only — dispatches on spoofed payload", () => {
    // Regression-lock: `match` dispatches via the `_tag` key into the
    // handler map without re-validating the payload. Production callers
    // (`AgentEvent.match` on events emitted in-process or decoded via
    // `Schema.decodeUnknownSync`) never see spoofed values.
    const out = Shape.match({
      Circle: (c) => `circle:${typeof c.radius}`,
      Rectangle: (r) => `rect:${r.width * r.height}`,
    })(spoof)
    expect(out).toBe("circle:string")
  })
})

describe("Schema.TaggedUnion — explicit wire tags via Schema.TaggedStruct + toTaggedUnion", () => {
  const TextDelta = Schema.TaggedStruct("text-delta", { text: Schema.String })
  const ToolCall = Schema.TaggedStruct("tool-call", {
    name: Schema.String,
    input: Schema.Unknown,
  })
  const ToolResult = Schema.TaggedStruct("tool-result", { result: Schema.Unknown })
  const Finished = Schema.TaggedStruct("finished", { reason: Schema.String })
  const WireEvent = Schema.Union([TextDelta, ToolCall, ToolResult, Finished]).pipe(
    Schema.toTaggedUnion("_tag"),
  )

  test("kebab-case wire tags construct through the per-variant struct", () => {
    const e = TextDelta.make({ text: "hello" })
    expect(e._tag).toBe("text-delta")
    expect(e.text).toBe("hello")
  })
  test("kebab-case wire tags decode through the union", () => {
    const decoded = Schema.decodeUnknownSync(WireEvent)({
      _tag: "text-delta",
      text: "hi",
    })
    expect(Schema.is(TextDelta)(decoded)).toBe(true)
  })
  test("match dispatches from wire-tag keys on the union", () => {
    const e = ToolCall.make({ name: "read", input: { path: "/x" } })
    const out = WireEvent.match(e, {
      "text-delta": (e) => `text:${e.text}`,
      "tool-call": (e) => `tool:${e.name}`,
      "tool-result": () => `result`,
      finished: () => `done`,
    })
    expect(out).toBe("tool:read")
  })
  test("`isAnyOf` accepts wire-tag keys", () => {
    const e = TextDelta.make({ text: "hello" })
    expect(WireEvent.isAnyOf(["text-delta"])(e)).toBe(true)
    expect(WireEvent.isAnyOf(["tool-call"])(e)).toBe(false)
  })
})

describe("Schema.TaggedUnion — single-variant edge case", () => {
  const Singleton = Schema.TaggedUnion({
    Only: { value: Schema.Number },
  })
  test("construct/decode single variant", () => {
    const o = Singleton.cases.Only.make({ value: 42 })
    expect(o._tag).toBe("Only")
    const decoded = Schema.decodeUnknownSync(Singleton)({ _tag: "Only", value: 42 })
    expect(decoded._tag).toBe("Only")
  })
})

describe("Schema.TaggedUnion — namespacing via TaggedStruct identity", () => {
  const A = Schema.TaggedUnion({ Shared: { value: Schema.Number } })
  const B = Schema.TaggedUnion({ Shared: { value: Schema.Number } })
  test("same member name across enums has distinct case identity", () => {
    expect(A.cases.Shared).not.toBe(B.cases.Shared)
  })
})

describe("Schema.TaggedUnion — AgentEvent JSON wire shape", () => {
  const sessionId = SessionId.make("session_tagged_enum_wire_shape")
  const branchId = BranchId.make("branch_tagged_enum_wire_shape")
  test("AgentEvent.SessionStarted JSON wire shape unchanged", () => {
    const evt = AgentEvent.cases.SessionStarted.make({ sessionId, branchId })
    const encoded = Schema.encodeUnknownSync(AgentEvent)(evt)
    expect(encoded).toEqual({ _tag: "SessionStarted", sessionId, branchId })
    const decoded = Schema.decodeUnknownSync(AgentEvent)(encoded)
    expect(Schema.is(AgentEvent.cases.SessionStarted)(decoded)).toBe(true)
  })
})

describe("Schema.TaggedUnion — Effect-friendly decode", () => {
  const Shape = Schema.TaggedUnion({
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  it.live("decode works inside Effect without service requirements", () =>
    Effect.gen(function* () {
      const program = Schema.decodeUnknownEffect(Shape)({
        _tag: "Rectangle",
        width: 3,
        height: 4,
      })
      const result = yield* program
      expect(result._tag).toBe("Rectangle")
      if (result._tag === "Rectangle") {
        expect(result.width * result.height).toBe(12)
      }
    }),
  )
})
