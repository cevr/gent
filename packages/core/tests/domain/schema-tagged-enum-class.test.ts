/**
 * `Schema.TaggedEnumClass` factory regression locks.
 *
 * Tests cover the direct-constructor contract:
 * - per-variant TaggedClass identity (`instanceof` survives decode)
 * - constructor surface (`MyEnum.Variant.make({...})`)
 * - no nested constructor surface
 * - PascalCase member enforcement
 * - explicit wire-tag preservation via `TaggedEnumClass.variant(...)`
 * - direct-member guards / match helpers
 * - decode + encode round-trip at the union level
 *
 * @module
 */
import { describe, test, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import { AgentEvent } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
describe("TaggedEnumClass — basic shape", () => {
  const Shape = TaggedEnumClass("Shape", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  test("variant access exposes a TaggedClass per direct member", () => {
    expect(typeof Shape.Circle).toBe("function")
    expect(typeof Shape.Rectangle).toBe("function")
    expect(Reflect.has(Shape, "cases")).toBe(false)
  })
  test("`Variant.make(...)` constructs an instance with the right `_tag`", () => {
    const c = Shape.Circle.make({ radius: 5 })
    expect(c._tag).toBe("Circle")
    expect(c.radius).toBe(5)
  })
  test("schema guards work on directly-constructed variants", () => {
    const c = Shape.Circle.make({ radius: 5 })
    const r = Shape.Rectangle.make({ width: 3, height: 4 })
    expect(Schema.is(Shape.Circle)(c)).toBe(true)
    expect(Schema.is(Shape.Rectangle)(r)).toBe(true)
    expect(Schema.is(Shape.Rectangle)(c)).toBe(false)
  })
  test("direct constructors produce stable variant instances", () => {
    const c1 = Shape.Circle.make({ radius: 5 })
    const c2 = Shape.Circle.make({ radius: 5 })
    expect(c1._tag).toBe(c2._tag)
    expect(c1.radius).toBe(c2.radius)
    expect(Schema.is(Shape.Circle)(c2)).toBe(true)
  })
})
describe("TaggedEnumClass — decode/encode round-trip", () => {
  const Shape = TaggedEnumClass("RoundTrip", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  test("decode returns class instances", () => {
    const decoded = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 5 })
    expect(Schema.is(Shape.Circle)(decoded)).toBe(true)
    expect(decoded._tag).toBe("Circle")
    if (decoded._tag === "Circle") {
      expect(decoded.radius).toBe(5)
    }
  })
  test("encode round-trips back to wire format", () => {
    const c = Shape.Circle.make({ radius: 5 })
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
describe("TaggedEnumClass — match / guards / isAnyOf", () => {
  const Shape = TaggedEnumClass("MatchShape", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
    Triangle: { base: Schema.Number, height: Schema.Number },
  })
  type Shape = Schema.Schema.Type<typeof Shape>
  test("`match` is exhaustive by direct member name", () => {
    const area = (s: Shape) =>
      Shape.match({
        Circle: (c) => Math.PI * c.radius ** 2,
        Rectangle: (r) => r.width * r.height,
        Triangle: (t) => (t.base * t.height) / 2,
      })(s)
    expect(area(Shape.Circle.make({ radius: 1 }))).toBeCloseTo(Math.PI)
    expect(area(Shape.Rectangle.make({ width: 3, height: 4 }))).toBe(12)
    expect(area(Shape.Triangle.make({ base: 4, height: 6 }))).toBe(12)
  })
  test("`guards` narrow per direct member", () => {
    const c = Shape.Circle.make({ radius: 5 })
    const r = Shape.Rectangle.make({ width: 1, height: 2 })
    expect(Shape.guards.Circle(c)).toBe(true)
    expect(Shape.guards.Circle(r)).toBe(false)
    expect(Shape.guards.Rectangle(r)).toBe(true)
    expect(Shape.guards.Rectangle(c)).toBe(false)
  })
  test("`isAnyOf` checks subset membership by direct member name", () => {
    const c = Shape.Circle.make({ radius: 5 })
    const r = Shape.Rectangle.make({ width: 1, height: 2 })
    const t = Shape.Triangle.make({ base: 1, height: 1 })
    const round = Shape.isAnyOf(["Circle"])
    const angular = Shape.isAnyOf(["Rectangle", "Triangle"])
    expect(round(c)).toBe(true)
    expect(round(r)).toBe(false)
    expect(angular(r)).toBe(true)
    expect(angular(t)).toBe(true)
    expect(angular(c)).toBe(false)
  })
})
describe("TaggedEnumClass — guards validate full payload shape", () => {
  const Shape = TaggedEnumClass("FullShape", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })
  // The type signatures on `isAnyOf` / `match` / `guards` claim to narrow
  // to a fully-typed variant. A spoofed `{ _tag: "Circle" }` with bad or
  // missing payload would otherwise pass a tag-only check and reach code
  // paths that trust the types.
  const spoofed = { _tag: "Circle", radius: "not a number" }
  const missingPayload = { _tag: "Circle" }
  test("`guards.X` rejects spoofed tag with invalid payload", () => {
    expect(Shape.guards.Circle(spoofed)).toBe(false)
    expect(Shape.guards.Circle(missingPayload)).toBe(false)
  })
  test("`isAnyOf` rejects spoofed tag with invalid payload", () => {
    const anyShape = Shape.isAnyOf(["Circle", "Rectangle"])
    expect(anyShape(spoofed)).toBe(false)
    expect(anyShape(missingPayload)).toBe(false)
    expect(anyShape(Shape.Circle.make({ radius: 1 }))).toBe(true)
  })
  test("`match` throws before dispatching when payload fails schema", () => {
    const handlers = {
      Circle: (c: { readonly radius: number }) => c.radius,
      Rectangle: (r: { readonly width: number; readonly height: number }) => r.width * r.height,
    }
    expect(() => Shape.match(handlers)(spoofed as never)).toThrow(/fails the variant schema/)
    expect(() => Shape.match(handlers)(missingPayload as never)).toThrow(/fails the variant schema/)
  })
})
describe("TaggedEnumClass — construction-time validation", () => {
  test("rejects empty variant map", () => {
    expect(() => TaggedEnumClass("Empty", {})).toThrow(/no variants/)
  })
  test("rejects payload field named `_tag`", () => {
    expect(() =>
      TaggedEnumClass("Bad", {
        Variant: { _tag: Schema.String, value: Schema.Number } as never,
      }),
    ).toThrow(/_tag/)
  })
  test("rejects schema utility names as direct variant members", () => {
    expect(() =>
      TaggedEnumClass("Weird", {
        cases: { value: Schema.Number } as never,
        Match: { value: Schema.Number } as never,
      }),
    ).toThrow(/PascalCase/)
  })
  test("rejects variant member named `__proto__`", () => {
    expect(() =>
      TaggedEnumClass("RejectsProto", {
        ["__proto__"]: { value: Schema.Number } as never,
        Normal: { value: Schema.Number },
      }),
    ).toThrow(/prototype/)
  })
})
describe("TaggedEnumClass — explicit wire tags", () => {
  const WireEvent = TaggedEnumClass("TestWireEvent", {
    TextDelta: TaggedEnumClass.variant("text-delta", { text: Schema.String }),
    ToolCall: TaggedEnumClass.variant("tool-call", {
      name: Schema.String,
      input: Schema.Unknown,
    }),
    ToolResult: TaggedEnumClass.variant("tool-result", { result: Schema.Unknown }),
    Finished: TaggedEnumClass.variant("finished", { reason: Schema.String }),
  })
  test("kebab-case wire tags construct through PascalCase members", () => {
    const e = WireEvent.TextDelta.make({ text: "hello" })
    expect(e._tag).toBe("text-delta")
    expect(e.text).toBe("hello")
  })
  test("kebab-case wire tags decode into direct member classes", () => {
    const decoded = Schema.decodeUnknownSync(WireEvent)({
      _tag: "text-delta",
      text: "hi",
    })
    expect(Schema.is(WireEvent.TextDelta)(decoded)).toBe(true)
  })
  test("direct-member match dispatches from wire tags", () => {
    const e = WireEvent.ToolCall.make({ name: "read", input: { path: "/x" } })
    const out = WireEvent.match({
      TextDelta: (e) => `text:${e.text}`,
      ToolCall: (e) => `tool:${e.name}`,
      ToolResult: () => `result`,
      Finished: () => `done`,
    })(e)
    expect(out).toBe("tool:read")
  })
  test("`isAnyOf` accepts direct member names and wire tags", () => {
    const e = WireEvent.TextDelta.make({ text: "hello" })
    expect(WireEvent.isAnyOf(["TextDelta"])(e)).toBe(true)
    expect(WireEvent.isAnyOf(["text-delta" as never])(e)).toBe(true)
    expect(WireEvent.isAnyOf(["ToolCall"])(e)).toBe(false)
    expect(WireEvent.isAnyOf(["tool-call" as never])(e)).toBe(false)
  })
  test("rejects lowercase or kebab members even when they would be valid wire tags", () => {
    expect(() =>
      TaggedEnumClass("BadWireEvent", {
        "text-delta": { text: Schema.String } as never,
      }),
    ).toThrow(/PascalCase/)
  })
})
describe("TaggedEnumClass — single-variant edge case", () => {
  const Singleton = TaggedEnumClass("Singleton", {
    Only: { value: Schema.Number },
  })
  test("construct/decode single variant", () => {
    const o = Singleton.Only.make({ value: 42 })
    expect(o._tag).toBe("Only")
    const decoded = Schema.decodeUnknownSync(Singleton)({ _tag: "Only", value: 42 })
    expect(Schema.is(Singleton.Only)(decoded)).toBe(true)
  })
})
describe("TaggedEnumClass — per-enum schema id namespacing", () => {
  const A = TaggedEnumClass("EnumA", { Shared: { value: Schema.Number } })
  const B = TaggedEnumClass("EnumB", { Shared: { value: Schema.Number } })
  test("same direct member name across enums has distinct class identity", () => {
    expect(A.Shared).not.toBe(B.Shared)
  })
  test("schema guards do not cross enum boundaries", () => {
    const a = A.Shared.make({ value: 1 })
    expect(Schema.is(A.Shared)(a)).toBe(true)
    expect(Schema.is(B.Shared)(a)).toBe(false)
  })
})
describe("TaggedEnumClass — AgentEvent JSON wire shape", () => {
  const sessionId = SessionId.make("session_tagged_enum_wire_shape")
  const branchId = BranchId.make("branch_tagged_enum_wire_shape")
  test("AgentEvent.SessionStarted JSON wire shape unchanged", () => {
    const evt = AgentEvent.SessionStarted.make({ sessionId, branchId })
    const encoded = Schema.encodeUnknownSync(AgentEvent)(evt)
    expect(encoded).toEqual({ _tag: "SessionStarted", sessionId, branchId })
    const decoded = Schema.decodeUnknownSync(AgentEvent)(encoded)
    expect(Schema.is(AgentEvent.SessionStarted)(decoded)).toBe(true)
  })
})
describe("TaggedEnumClass — Effect-friendly decode", () => {
  const Shape = TaggedEnumClass("EffectShape", {
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
      expect(Schema.is(Shape.Rectangle)(result)).toBe(true)
      if (result._tag === "Rectangle") {
        expect(result.width * result.height).toBe(12)
      }
    }),
  )
})
