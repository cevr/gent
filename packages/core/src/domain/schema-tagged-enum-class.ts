/**
 * `Schema.TaggedEnumClass` — a single-call factory for discriminated unions.
 *
 * Wraps `Schema.Union([...TaggedClass]).pipe(Schema.toTaggedUnion("_tag"))`
 * while exposing per-variant constructors directly on the enum object:
 * `MyEnum.Variant.make({...})`.
 *
 * Variant member names are PascalCase API names. The wire `_tag` defaults to
 * that member name, or can be pinned with `TaggedEnumClass.variant(...)` for
 * persisted/transported legacy tags:
 *
 * ```ts
 * export const Message = TaggedEnumClass("Message", {
 *   Regular: TaggedEnumClass.variant("regular", MessageFields),
 * })
 *
 * const message = Message.Regular.make(...)
 * // message._tag === "regular"
 * ```
 *
 * Discriminator is locked to `_tag`.
 *
 * @module
 */
import { Schema } from "effect"

/**
 * Per-variant fields. Mirrors `Schema.Struct.Fields` — a record of
 * field-name to Schema.
 */
export type VariantFields = Schema.Struct.Fields

/**
 * Brand attached to ask-able variant *instances* (not their encoded form).
 * Carries the phantom reply type so `ActorContext.ask` can infer the answer
 * channel without a replyKey lambda. Authors never name this brand directly —
 * it is added by `askVariant<R>()(fields)` and read by `ask`.
 */
export declare const AskReplyBrand: unique symbol

export interface AskBranded<out Reply> {
  /**
   * Phantom only — undefined at runtime, erased after compilation. Returns
   * `Reply` (covariant position) so a more-specific reply type (e.g. `number`)
   * is assignable to a less-specific one (e.g. `unknown`). A parameter
   * position would invert this and reject specific-into-general assignment,
   * which would break the `M extends N & AskBranded<unknown>` constraint.
   */
  readonly [AskReplyBrand]?: () => Reply
}

/**
 * Type-level extractor: produces `Reply` for ask-branded values, `never`
 * otherwise. Used by `ActorContext.ask` to infer the reply channel from the
 * message argument's static type.
 */
export type ExtractAskReply<M> = M extends AskBranded<infer R> ? R : never

const taggedEnumVariantDefinitionMarker: unique symbol = Symbol(
  "@gent/core/TaggedEnumClass/variant",
)

const askVariantMarker: unique symbol = Symbol("@gent/core/TaggedEnumClass/askVariant")

export interface TaggedEnumVariantDefinition<Tag extends string, F extends VariantFields> {
  readonly [taggedEnumVariantDefinitionMarker]: true
  readonly tag: Tag
  readonly fields: F
}

/**
 * Variant definition that brands the resulting variant constructor with a
 * phantom `Reply` type for ask-correlated messages. The brand lives on the
 * constructor's *instance* type only — it is not added to `Schema.Struct.Type<F>`
 * and therefore does not appear in the encoded (JSON) shape.
 *
 * Author with `askVariant<R>()(fields)`. The runtime drops the marker before
 * `Schema.TaggedClass` ever sees it; the type system propagates `Reply` through
 * to `ActorContext.ask`, which infers it without a replyKey lambda.
 */
export interface AskVariantDefinition<F extends VariantFields, out Reply> {
  readonly [askVariantMarker]: true
  readonly fields: F
  /** Phantom — never read at runtime, never written, erased after compilation. */
  readonly _phantomReply?: () => Reply
}

export type VariantDefinition =
  | VariantFields
  | TaggedEnumVariantDefinition<string, VariantFields>
  | AskVariantDefinition<VariantFields, unknown>

/**
 * Map of PascalCase variant member → field schemas or explicit wire-tag
 * definition. Constraint is `unknown` (not `VariantDefinition`) so the
 * `<const V>` inference doesn't widen each property to fit the union and
 * destroy the literal field shapes — type-level enforcement happens
 * downstream via `TaggedEnumClassInput<V>`, which checks each property
 * against the expected variant shape on a per-key basis.
 */
export type VariantsMap = Record<string, unknown>

/**
 * Resolve the field shape for a variant value.
 *
 * The default branch returns `{}` (empty record) — NOT `VariantFields` —
 * specifically so `keyof VariantFieldsOf<unknown>` is `never` (instead of
 * `string`). With the `string` fallback, downstream conditionals like
 * `"_tag" extends keyof VariantFieldsOf<V[K]>` would always evaluate to
 * `true` when V is generic, falsely tripping the `_tag` error branch in
 * `TaggedEnumClassInput`.
 */
export type VariantFieldsOf<D> =
  D extends TaggedEnumVariantDefinition<string, infer F>
    ? F
    : D extends AskVariantDefinition<infer F, unknown>
      ? F
      : D extends VariantFields
        ? D
        : Record<never, never>

export type VariantWireTagOf<Name extends string, D> =
  D extends TaggedEnumVariantDefinition<infer Tag, VariantFields> ? Tag : Name

/**
 * Phantom-only extractor — produces `Reply` for ask-able variants, `never` for
 * tell-only variants. `ActorContext.ask` reads this off the message type to
 * infer the answer channel without a replyKey lambda.
 */
export type VariantReplyOf<D> = D extends AskVariantDefinition<VariantFields, infer R> ? R : never

export type VariantMemberName<Name extends string> =
  Name extends Capitalize<Name>
    ? Name extends `${string}-${string}`
      ? never
      : Name extends `${string}.${string}`
        ? never
        : Name
    : never

/**
 * Type-level guard: the variant fields must NOT contain a `_tag` field —
 * `Schema.TaggedClass` would silently let the payload override the
 * discriminator literal. Detected at compile time via this conditional;
 * also enforced at runtime by `assertNoTagField` so a non-typed authoring
 * path can't sneak past.
 */
export type AssertNoTagField<F extends VariantFields> = "_tag" extends keyof F
  ? {
      readonly __error: "TaggedEnumClass: variant fields may not contain a `_tag` key (collides with the discriminator)."
    }
  : F

export type ReservedVariantMember = "__proto__"

export type AssertNoReservedMembers<V extends VariantsMap> = {
  readonly [K in keyof V]: K extends ReservedVariantMember
    ? {
        readonly __error: "TaggedEnumClass: variant member collides with JavaScript prototype semantics."
      }
    : V[K]
}

/**
 * Defect raised at construction time when the variant map violates the
 * factory's preconditions. These are programmer errors, not user-input
 * errors — they surface as a thrown defect at module-load time so the
 * type-level checks are not the only safety net.
 */
export class TaggedEnumClassConfigError extends Schema.TaggedErrorClass<TaggedEnumClassConfigError>()(
  "TaggedEnumClassConfigError",
  {
    message: Schema.String,
  },
) {}

const isVariantDefinition = (
  value: unknown,
): value is TaggedEnumVariantDefinition<string, VariantFields> =>
  typeof value === "object" &&
  value !== null &&
  taggedEnumVariantDefinitionMarker in value &&
  value[taggedEnumVariantDefinitionMarker] === true

const isAskVariantDefinition = (
  value: unknown,
): value is AskVariantDefinition<VariantFields, unknown> =>
  typeof value === "object" &&
  value !== null &&
  askVariantMarker in value &&
  (value as { [askVariantMarker]: unknown })[askVariantMarker] === true

const PascalCaseMemberPattern = /^[A-Z][A-Za-z0-9]*$/

const getVariantConfig = (
  name: string,
  definition: VariantDefinition,
): {
  readonly tag: string
  readonly fields: VariantFields
} => {
  if (isVariantDefinition(definition)) {
    return { tag: definition.tag, fields: definition.fields }
  }
  if (isAskVariantDefinition(definition)) {
    return { tag: name, fields: definition.fields }
  }
  return { tag: name, fields: definition as VariantFields }
}

/**
 * Build a per-variant `Schema.TaggedClass`. The class identity is unique
 * to this call (each `Schema.TaggedClass<Self>()` invocation produces a
 * distinct class), and the schema id namespaces the variant under the
 * enum identifier so two TaggedEnums that share a variant name have
 * distinct schema brands.
 */
const buildVariantClass = <Tag extends string, F extends VariantFields>(
  identifier: string,
  memberName: string,
  tag: Tag,
  fields: F,
): TaggedEnumClassVariant<Tag, F> => {
  const schemaId = `${identifier}/${memberName}`
  const variant = Schema.TaggedClass<Schema.Struct.Type<F> & { readonly _tag: Tag }>(schemaId)(
    tag,
    fields,
  )
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
  return variant as unknown as TaggedEnumClassVariant<Tag, F>
}

/**
 * Per-variant TaggedClass schema. Self-typed via a recursive interface so the
 * class instance properties match the field shape (`Schema.Schema.Type<F>`)
 * AND the constructor call shape (`MyEnum.Variant.make({...fields})`). The
 * `_tag` literal is added by `Schema.TaggedClass` and is not part of `F`.
 *
 * The optional `Reply` parameter brands the *instance* type (the return of
 * `new` and `make`) with `AskBranded<Reply>` so `ActorContext.ask` can infer
 * the reply channel. The brand is NOT added to `Schema.Struct.Type<F>` and
 * therefore does not appear in the encoded/JSON shape.
 */
// eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
export interface TaggedEnumClassVariant<
  Tag extends string,
  F extends VariantFields,
  Reply = never,
  // eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
> extends Schema.Codec<
  Schema.Struct.Type<F> & { readonly _tag: Tag } & ([Reply] extends [never]
      ? unknown
      : AskBranded<Reply>),
  Schema.Struct.Encoded<F> & { readonly _tag: Tag },
  Schema.Struct.DecodingServices<F>,
  Schema.Struct.EncodingServices<F>
> {
  // Constructor input mirrors `Schema.TaggedClass`'s contract: a rest tuple
  // form so when every field is optional/defaulted the props arg may itself
  // be omitted (`MyEnum.Variant.make()`), and `MakeOptions` (validation
  // toggles) is accepted as a second argument.
  new (
    ...args: Record<string, never> extends Schema.Struct.MakeIn<F>
      ? [props?: Schema.Struct.MakeIn<F>, options?: Schema.MakeOptions]
      : [props: Schema.Struct.MakeIn<F>, options?: Schema.MakeOptions]
  ): Schema.Struct.Type<F> & { readonly _tag: Tag } & ([Reply] extends [never]
      ? unknown
      : AskBranded<Reply>)
}

type TaggedEnumType<V extends VariantsMap> = {
  readonly [K in keyof V & string]: Schema.Struct.Type<VariantFieldsOf<V[K]>> & {
    readonly _tag: VariantWireTagOf<K, V[K]>
  } & ([VariantReplyOf<V[K]>] extends [never] ? unknown : AskBranded<VariantReplyOf<V[K]>>)
}[keyof V & string]

type TaggedEnumEncoded<V extends VariantsMap> = {
  readonly [K in keyof V & string]: Schema.Struct.Encoded<VariantFieldsOf<V[K]>> & {
    readonly _tag: VariantWireTagOf<K, V[K]>
  }
}[keyof V & string]

/**
 * The TaggedEnumClass result. Combines the underlying tagged-union schema with
 * direct per-variant constructors, plus guards/isAnyOf/match keyed by the same
 * PascalCase API member names.
 */
// eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
export type TaggedEnumClass<V extends VariantsMap> = Schema.Codec<
  TaggedEnumType<V>,
  TaggedEnumEncoded<V>,
  { [K in keyof V & string]: Schema.Struct.DecodingServices<VariantFieldsOf<V[K]>> }[keyof V &
    string],
  { [K in keyof V & string]: Schema.Struct.EncodingServices<VariantFieldsOf<V[K]>> }[keyof V &
    string]
> & {
  readonly [K in keyof V & string]: TaggedEnumClassVariant<
    VariantWireTagOf<K, V[K]>,
    VariantFieldsOf<V[K]>,
    VariantReplyOf<V[K]>
  >
} & {
  readonly guards: {
    readonly [K in keyof V & string]: (u: unknown) => u is Schema.Struct.Type<
      VariantFieldsOf<V[K]>
    > & {
      readonly _tag: VariantWireTagOf<K, V[K]>
    }
  }
  readonly isAnyOf: <const Members extends ReadonlyArray<keyof V & string>>(
    members: Members,
  ) => (u: unknown) => u is {
    readonly [K in Members[number]]: Schema.Struct.Type<VariantFieldsOf<V[K]>> & {
      readonly _tag: VariantWireTagOf<K, V[K]>
    }
  }[Members[number]]
  readonly match: {
    <
      Handlers extends {
        readonly [K in keyof V & string]: (
          v: Schema.Struct.Type<VariantFieldsOf<V[K]>> & {
            readonly _tag: VariantWireTagOf<K, V[K]>
          },
        ) => unknown
      },
    >(
      handlers: Handlers,
    ): (v: TaggedEnumType<V>) => ReturnType<Handlers[keyof Handlers]>
    <
      Handlers extends {
        readonly [K in keyof V & string]: (
          v: Schema.Struct.Type<VariantFieldsOf<V[K]>> & {
            readonly _tag: VariantWireTagOf<K, V[K]>
          },
        ) => unknown
      },
    >(
      v: TaggedEnumType<V>,
      handlers: Handlers,
    ): ReturnType<Handlers[keyof Handlers]>
  }
}

type TaggedEnumClassInput<V extends VariantsMap> = V & {
  readonly [K in keyof V & string]: K extends ReservedVariantMember
    ? {
        readonly __error: "TaggedEnumClass: variant member collides with a reserved key on the wrapper or JavaScript prototype semantics."
      }
    : K extends VariantMemberName<K>
      ? "_tag" extends keyof VariantFieldsOf<V[K]>
        ? {
            readonly __error: "TaggedEnumClass: variant fields may not contain a `_tag` key (collides with the discriminator)."
          }
        : V[K]
      : {
          readonly __error: "TaggedEnumClass: variant member names must be PascalCase identifiers. Use TaggedEnumClass.variant(...) to preserve a different wire _tag."
        }
}

const makeVariantDefinition = <const Tag extends string, const F extends VariantFields>(
  tag: Tag,
  fields: F & AssertNoTagField<F>,
): TaggedEnumVariantDefinition<Tag, F> => ({
  [taggedEnumVariantDefinitionMarker]: true,
  tag,
  fields,
})

/**
 * Factory for ask-able variants. Author with:
 *
 * ```ts
 * const SessionMsg = TaggedEnumClass("SessionMsg", {
 *   EstimateContextPercent: TaggedEnumClass.askVariant<number>()({}),
 *   ListMessages: TaggedEnumClass.askVariant<ReadonlyArray<Message>>()({}),
 *   RecordEvent: { event: AgentEvent }, // tell-only, no reply
 * })
 *
 * const pct = yield* ctx.actors.ask(ref, SessionMsg.EstimateContextPercent.make({}))
 * //    ^? number — inferred from the brand on the variant constructor
 * ```
 *
 * Tell-only variants (declared as plain field maps) do not carry the brand
 * and are rejected by `ask` at the type level.
 *
 * Two-step `<R>()(fields)` rather than `<R>(fields)` so callers can pin
 * `Reply` explicitly while letting TypeScript infer the field shape from
 * `fields`.
 */
const makeAskVariantDefinition =
  <Reply>() =>
  <const F extends VariantFields>(
    fields: F & AssertNoTagField<F>,
  ): AskVariantDefinition<F, Reply> => ({
    [askVariantMarker]: true,
    fields,
  })

export interface TaggedEnumClassFactory {
  <const V extends VariantsMap>(
    identifier: string,
    variants: TaggedEnumClassInput<V>,
  ): TaggedEnumClass<V>
  readonly variant: typeof makeVariantDefinition
  readonly askVariant: typeof makeAskVariantDefinition
}

const makeTaggedEnumClass = <const V extends VariantsMap>(
  identifier: string,
  variants: TaggedEnumClassInput<V>,
): TaggedEnumClass<V> => {
  const variantEntries = Object.entries(variants)
  if (variantEntries.length === 0) {
    throw new TaggedEnumClassConfigError({
      message: `TaggedEnumClass: "${identifier}" was constructed with no variants — the union would be uninhabited.`,
    })
  }

  const memberToWireTag = new Map<string, string>()
  const wireTagToMember = new Map<string, string>()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
  const variantClasses = Object.create(null) as Record<
    string,
    Schema.Top & { readonly Type: { readonly _tag: string } }
  >

  for (const [memberName, definition] of variantEntries) {
    if (memberName === "__proto__") {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${memberName}" collides with JavaScript prototype semantics.`,
      })
    }
    if (!PascalCaseMemberPattern.test(memberName)) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${memberName}" must be a PascalCase identifier. Use TaggedEnumClass.variant("${memberName}", fields) under a PascalCase member to preserve that wire _tag.`,
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- input type intersects an error branch when the user mistypes; runtime guards in getVariantConfig handle every legal shape
    const { tag, fields } = getVariantConfig(memberName, definition as unknown as VariantDefinition)
    if (Object.prototype.hasOwnProperty.call(fields, "_tag")) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${memberName}" declares a "_tag" field — Effect's TaggedClass would let the payload override the discriminator literal. Remove the field; the discriminator is implicit.`,
      })
    }
    if (wireTagToMember.has(tag)) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" wire tag "${tag}" is assigned to both "${wireTagToMember.get(tag)}" and "${memberName}". Wire tags must be unique.`,
      })
    }

    memberToWireTag.set(memberName, tag)
    wireTagToMember.set(tag, memberName)
    variantClasses[memberName] = buildVariantClass(identifier, memberName, tag, fields)
  }

  const members = Object.values(variantClasses)
  const union = Schema.Union(members).pipe(Schema.toTaggedUnion("_tag"))
  Reflect.deleteProperty(union, "cases")

  // Per-variant full-shape guards. Each is `Schema.is(Variant)`, so it
  // validates the payload as well as the discriminator — not just
  // `{ _tag: "X" }`.
  const guardByMember = Object.fromEntries(
    Object.entries(variantClasses).map(([memberName, variant]) => [memberName, Schema.is(variant)]),
  ) as Record<string, (u: unknown) => boolean>
  const guards = guardByMember
  // `isAnyOf` composes those per-variant guards — accepting either the
  // member name or its wire tag — so a spoofed `{ _tag: "X" }` with the
  // wrong payload shape fails instead of slipping through as a tag-only
  // match. This matches the type signature, which claims to narrow to
  // the full variant type.
  const isAnyOf = (members: ReadonlyArray<string>) => {
    const allowedMembers = new Set<string>()
    for (const member of members) {
      if (guardByMember[member] !== undefined) {
        allowedMembers.add(member)
        continue
      }
      const resolved = wireTagToMember.get(member)
      if (resolved !== undefined) allowedMembers.add(resolved)
    }
    return (u: unknown): boolean => {
      for (const member of allowedMembers) {
        const guard = guardByMember[member]
        if (guard !== undefined && guard(u)) return true
      }
      return false
    }
  }
  const getHandler = (
    handlers: unknown,
    member: string,
  ): ((value: unknown) => unknown) | undefined => {
    if (typeof handlers !== "object" || handlers === null) return undefined
    const handler = Reflect.get(handlers, member)
    if (typeof handler !== "function") return undefined
    return (value: unknown) => Reflect.apply(handler, undefined, [value])
  }

  const match = (valueOrHandlers: unknown, maybeHandlers?: unknown) => {
    const run = (value: unknown, handlers: unknown) => {
      if (typeof value !== "object" || value === null || !("_tag" in value)) {
        throw new TaggedEnumClassConfigError({
          message: `TaggedEnumClass: "${identifier}" match received a value without an _tag discriminator.`,
        })
      }
      const tag = (value as { readonly _tag?: unknown })._tag
      const member = typeof tag === "string" ? wireTagToMember.get(tag) : undefined
      if (member === undefined) {
        throw new TaggedEnumClassConfigError({
          message: `TaggedEnumClass: "${identifier}" match received unknown _tag "${String(tag)}".`,
        })
      }
      // Validate the full variant shape before dispatch — the handler
      // type signature promises a fully-typed variant, not just a tag
      // discriminator. A payload with the right tag but malformed
      // fields would otherwise reach the handler as a typed lie.
      const memberGuard = guardByMember[member]
      if (memberGuard === undefined || !memberGuard(value)) {
        throw new TaggedEnumClassConfigError({
          message: `TaggedEnumClass: "${identifier}" match received value tagged "${String(tag)}" whose payload fails the variant schema.`,
        })
      }
      const handler = getHandler(handlers, member)
      if (handler === undefined) {
        throw new TaggedEnumClassConfigError({
          message: `TaggedEnumClass: "${identifier}" match is missing handler "${member}".`,
        })
      }
      return handler(value)
    }

    if (maybeHandlers !== undefined) {
      return run(valueOrHandlers, maybeHandlers)
    }
    return (value: unknown) => run(value, valueOrHandlers)
  }

  const result = Object.assign(union, variantClasses, {
    guards,
    isAnyOf,
    match,
  })

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
  return result as unknown as TaggedEnumClass<V>
}

export const TaggedEnumClass: TaggedEnumClassFactory = Object.assign(makeTaggedEnumClass, {
  variant: makeVariantDefinition,
  askVariant: makeAskVariantDefinition,
})
