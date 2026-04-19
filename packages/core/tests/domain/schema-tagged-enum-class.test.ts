/**
 * `Schema.TaggedEnumClass` factory regression locks.
 *
 * Tests cover the behavioral contract codex's design review committed to:
 * - per-variant TaggedClass identity (`instanceof` survives decode)
 * - smart-constructor surface (`MyEnum.Variant({...})` and `new MyEnum.Variant({...})`)
 * - `cases` / `guards` / `match` augmentation from Schema.toTaggedUnion
 * - decode + encode round-trip at the union level
 * - construction-time rejection of empty variants
 * - construction-time rejection of `_tag` payload field collisions
 * - construction-time rejection of reserved variant tag names
 * - non-identifier tag names (lowercase, hyphen, dot) survive
 * - per-enum schema id namespacing (two enums with same variant name
 *   produce distinct branded schemas)
 *
 * @module
 */
import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import {
  __getReservedTagsForTesting,
  TaggedEnumClass,
  type ReservedVariantTag,
} from "@gent/core/domain/schema-tagged-enum-class"
import { AgentEvent } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"

describe("TaggedEnumClass — basic shape", () => {
  const Shape = TaggedEnumClass("Shape", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })

  test("variant access exposes a TaggedClass per variant", () => {
    expect(typeof Shape.Circle).toBe("function")
    expect(typeof Shape.Rectangle).toBe("function")
  })

  test("`new Variant(...)` constructs an instance with the right `_tag`", () => {
    const c = new Shape.Circle({ radius: 5 })
    expect(c._tag).toBe("Circle")
    expect(c.radius).toBe(5)
  })

  test("`instanceof` works on directly-constructed variants", () => {
    const c = new Shape.Circle({ radius: 5 })
    const r = new Shape.Rectangle({ width: 3, height: 4 })
    expect(c instanceof Shape.Circle).toBe(true)
    expect(r instanceof Shape.Rectangle).toBe(true)
    expect(c instanceof Shape.Rectangle).toBe(false)
  })

  test("`cases.Variant.make(...)` constructs the same shape as `new Variant`", () => {
    const c1 = new Shape.Circle({ radius: 5 })
    const c2 = Shape.cases.Circle.make({ radius: 5 })
    expect(c1._tag).toBe(c2._tag)
    expect(c1.radius).toBe(c2.radius)
    expect(c2 instanceof Shape.Circle).toBe(true)
  })
})

describe("TaggedEnumClass — decode/encode round-trip", () => {
  const Shape = TaggedEnumClass("RoundTrip", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })

  test("decode returns class instances (not plain objects)", () => {
    const decoded = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 5 })
    // The contract codex committed to: decoded values pass `instanceof Variant`.
    // This is the load-bearing fact for consumer-side `instanceof` checks.
    expect(decoded instanceof Shape.Circle).toBe(true)
    expect(decoded._tag).toBe("Circle")
    if (decoded._tag === "Circle") {
      expect(decoded.radius).toBe(5)
    }
  })

  test("encode round-trips back to wire format", () => {
    const c = new Shape.Circle({ radius: 5 })
    const encoded = Schema.encodeUnknownSync(Shape)(c)
    expect(encoded).toEqual({ _tag: "Circle", radius: 5 })
  })

  test("decode rejects unknown `_tag`", () => {
    expect(() => Schema.decodeUnknownSync(Shape)({ _tag: "Unknown", radius: 5 })).toThrow()
  })

  test("decode rejects malformed payload (wrong field type)", () => {
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

  test("`match` is exhaustive at compile time", () => {
    const area = (s: Shape) =>
      Shape.match({
        Circle: (c) => Math.PI * c.radius ** 2,
        Rectangle: (r) => r.width * r.height,
        Triangle: (t) => (t.base * t.height) / 2,
      })(s)

    expect(area(new Shape.Circle({ radius: 1 }))).toBeCloseTo(Math.PI)
    expect(area(new Shape.Rectangle({ width: 3, height: 4 }))).toBe(12)
    expect(area(new Shape.Triangle({ base: 4, height: 6 }))).toBe(12)
  })

  test("`guards` narrow per-variant", () => {
    const c = new Shape.Circle({ radius: 5 })
    const r = new Shape.Rectangle({ width: 1, height: 2 })
    expect(Shape.guards.Circle(c)).toBe(true)
    expect(Shape.guards.Circle(r)).toBe(false)
    expect(Shape.guards.Rectangle(r)).toBe(true)
    expect(Shape.guards.Rectangle(c)).toBe(false)
  })

  test("`isAnyOf` checks subset membership", () => {
    const c = new Shape.Circle({ radius: 5 })
    const r = new Shape.Rectangle({ width: 1, height: 2 })
    const t = new Shape.Triangle({ base: 1, height: 1 })
    const round = Shape.isAnyOf(["Circle"])
    const angular = Shape.isAnyOf(["Rectangle", "Triangle"])
    expect(round(c)).toBe(true)
    expect(round(r)).toBe(false)
    expect(angular(r)).toBe(true)
    expect(angular(t)).toBe(true)
    expect(angular(c)).toBe(false)
  })
})

describe("TaggedEnumClass — construction-time validation", () => {
  // The static `ReservedVariantTag` type union and the runtime
  // `RESERVED_TAGS` set must remain in lockstep. Codex's S0 review caught
  // two independent bugs from the static list drifting:
  //   - missed `makeEffect`/`makeOption`/`mapMembers`/`rebuild` (own-key
  //     additions to the augmented Union)
  //   - missed `pipe`/`annotate`/`annotateKey`/`check` (inherited methods
  //     from `Schema.Bottom` that Object.assign happily shadows)
  //
  // This test asserts exact set equality between the runtime probe and the
  // hand-mirrored static type union, so any future Effect change that adds
  // or removes a reserved key fails this test rather than silently letting
  // a variant tag shadow critical schema methods.
  test("static `ReservedVariantTag` type union matches runtime probe set", () => {
    const runtimeSet = __getReservedTagsForTesting()
    const staticSet = new Set<ReservedVariantTag>([
      "annotate",
      "annotateKey",
      "ast",
      "cases",
      "check",
      "guards",
      "isAnyOf",
      "make",
      "makeEffect",
      "makeOption",
      "mapMembers",
      "match",
      "members",
      "pipe",
      "rebuild",
    ])
    // Set equality both ways — fails on additions or removals.
    const runtimeOnly = [...runtimeSet].filter((k) => !staticSet.has(k as ReservedVariantTag))
    const staticOnly = [...staticSet].filter((k) => !runtimeSet.has(k))
    expect(runtimeOnly).toEqual([])
    expect(staticOnly).toEqual([])
  })

  test("rejects every reserved key (parametrized over the runtime probe)", () => {
    for (const key of __getReservedTagsForTesting()) {
      expect(() =>
        TaggedEnumClass("ReservedScan", {
          [key]: { value: Schema.Number },
        }),
      ).toThrow(/reserved/)
    }
  })

  test("rejects empty variant map", () => {
    expect(() => TaggedEnumClass("Empty", {})).toThrow(/no variants/)
  })

  test("rejects payload field named `_tag` (would override the discriminator)", () => {
    expect(() =>
      TaggedEnumClass("Bad", {
        Variant: { _tag: Schema.String, value: Schema.Number },
      }),
    ).toThrow(/_tag/)
  })

  test("rejects variant tag named `cases` (collides with augmentation key)", () => {
    expect(() =>
      TaggedEnumClass("Reserved", {
        cases: { value: Schema.Number },
      }),
    ).toThrow(/reserved/)
  })

  test("rejects variant tag named `match` (collides with augmentation key)", () => {
    expect(() =>
      TaggedEnumClass("Reserved", {
        match: { value: Schema.Number },
      }),
    ).toThrow(/reserved/)
  })

  test("rejects variant tag named `guards`", () => {
    expect(() =>
      TaggedEnumClass("Reserved", {
        guards: { value: Schema.Number },
      }),
    ).toThrow(/reserved/)
  })

  test("rejects variant tag named `pipe` (inherited Schema method)", () => {
    // `Object.assign(union, variantClasses)` installs the variant
    // constructor as an own property — that own property SHADOWS the
    // inherited `pipe` method from `Schema.Bottom`'s prototype, breaking
    // the schema API. Probe walks the entire prototype chain so this is
    // detected.
    expect(() =>
      TaggedEnumClass("RejectsPipe", {
        pipe: { value: Schema.Number },
      }),
    ).toThrow(/reserved/)
  })
})

describe("TaggedEnumClass — non-identifier tag names", () => {
  // Hyphens and dots in tag names test the bracket-access path
  // (`MyEnum["text-delta"]` instead of `MyEnum.textDelta`). Critical for
  // `TurnEvent` which uses kebab-case.
  const TurnEvent = TaggedEnumClass("TestTurnEvent", {
    "text-delta": { text: Schema.String },
    "tool-call": { name: Schema.String, input: Schema.Unknown },
    "tool-result": { result: Schema.Unknown },
    finish: { reason: Schema.String },
  })

  test("kebab-case tags accessible via bracket notation", () => {
    expect(typeof TurnEvent["text-delta"]).toBe("function")
    expect(typeof TurnEvent["tool-call"]).toBe("function")
  })

  test("kebab-case tag construction works", () => {
    const e = new TurnEvent["text-delta"]({ text: "hello" })
    expect(e._tag).toBe("text-delta")
    expect(e.text).toBe("hello")
  })

  test("kebab-case decode + instanceof", () => {
    const decoded = Schema.decodeUnknownSync(TurnEvent)({
      _tag: "text-delta",
      text: "hi",
    })
    expect(decoded instanceof TurnEvent["text-delta"]).toBe(true)
  })

  test("kebab-case match", () => {
    const e = new TurnEvent["tool-call"]({ name: "read", input: { path: "/x" } })
    const out = TurnEvent.match({
      "text-delta": (e) => `text:${e.text}`,
      "tool-call": (e) => `tool:${e.name}`,
      "tool-result": () => `result`,
      finish: () => `done`,
    })(e)
    expect(out).toBe("tool:read")
  })
})

describe("TaggedEnumClass — single-variant edge case", () => {
  // Codex called this out as a corner: empty rejected, but single-variant
  // should still work — the union degenerates to one TaggedClass.
  const Singleton = TaggedEnumClass("Singleton", {
    Only: { value: Schema.Number },
  })

  test("single-variant decode + construct + match works", () => {
    const o = new Singleton.Only({ value: 42 })
    expect(o._tag).toBe("Only")
    const decoded = Schema.decodeUnknownSync(Singleton)({ _tag: "Only", value: 42 })
    expect(decoded instanceof Singleton.Only).toBe(true)
    const out = Singleton.match({ Only: (o) => o.value })(decoded)
    expect(out).toBe(42)
  })
})

describe("TaggedEnumClass — per-enum schema id namespacing", () => {
  // Two TaggedEnums share a variant name. Per the `${identifier}/${tag}`
  // schema id convention, the underlying Schema brands are distinct so
  // future schema-id-keyed lookups don't collide. Runtime class identity
  // is also distinct (each TaggedClass call returns a fresh constructor).
  const A = TaggedEnumClass("EnumA", { Shared: { value: Schema.Number } })
  const B = TaggedEnumClass("EnumB", { Shared: { value: Schema.Number } })

  test("classes from different enums are distinct constructors", () => {
    expect(A.Shared).not.toBe(B.Shared)
  })

  test("instances from one enum do not pass instanceof of the other", () => {
    const a = new A.Shared({ value: 1 })
    expect(a instanceof A.Shared).toBe(true)
    expect(a instanceof B.Shared).toBe(false)
  })
})

describe("TaggedEnumClass — AgentEvent migration smoke", () => {
  // Per codex review of S0: an AgentEvent-specific roundtrip test that
  // exercises the wire-shape contract (`{ _tag, ...fields }` JSON ⟷
  // class instance) belongs at the substrate layer, not only in the
  // generic substrate tests above. The full SQLite path is covered by
  // `tests/storage/sqlite-storage.test.ts`; this is a tighter check that
  // the migration preserved the documented wire shape.
  test("AgentEvent.SessionStarted JSON wire shape unchanged", () => {
    const sessionId = SessionId.of("01234567-89ab-7cde-8123-456789abcdef")
    const branchId = BranchId.of("01234567-89ab-7cde-8123-456789abcdee")
    const evt = new AgentEvent.SessionStarted({ sessionId, branchId })
    const encoded = Schema.encodeUnknownSync(AgentEvent)(evt)
    expect(encoded).toEqual({ _tag: "SessionStarted", sessionId, branchId })
    const decoded = Schema.decodeUnknownSync(AgentEvent)(encoded)
    expect(decoded instanceof AgentEvent.SessionStarted).toBe(true)
    if (decoded._tag === "SessionStarted") {
      expect(decoded.sessionId).toBe(sessionId)
      expect(decoded.branchId).toBe(branchId)
    }
  })
})

describe("TaggedEnumClass — Effect-friendly decode", () => {
  const Shape = TaggedEnumClass("EffectShape", {
    Circle: { radius: Schema.Number },
    Rectangle: { width: Schema.Number, height: Schema.Number },
  })

  test("decodeUnknownEffect succeeds inside an Effect.gen", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(Shape)({
          _tag: "Rectangle",
          width: 2,
          height: 3,
        })
        return decoded
      }),
    )
    expect(result instanceof Shape.Rectangle).toBe(true)
    if (result._tag === "Rectangle") {
      expect(result.width).toBe(2)
      expect(result.height).toBe(3)
    }
  })
})
