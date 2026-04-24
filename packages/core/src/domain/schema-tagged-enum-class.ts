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

const taggedEnumVariantDefinitionMarker: unique symbol = Symbol.for(
  "@gent/core/TaggedEnumClass/variant",
)

export interface TaggedEnumVariantDefinition<Tag extends string, F extends VariantFields> {
  readonly [taggedEnumVariantDefinitionMarker]: true
  readonly tag: Tag
  readonly fields: F
}

export type VariantDefinition = VariantFields | TaggedEnumVariantDefinition<string, VariantFields>

/**
 * Map of PascalCase variant member → field schemas or explicit wire-tag
 * definition.
 */
export type VariantsMap = Record<string, VariantDefinition>

export type VariantFieldsOf<D extends VariantDefinition> =
  D extends TaggedEnumVariantDefinition<string, infer F> ? F : D

export type VariantWireTagOf<Name extends string, D extends VariantDefinition> =
  D extends TaggedEnumVariantDefinition<infer Tag, VariantFields> ? Tag : Name

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

const PascalCaseMemberPattern = /^[A-Z][A-Za-z0-9]*$/

const getVariantConfig = (
  name: string,
  definition: VariantDefinition,
): {
  readonly tag: string
  readonly fields: VariantFields
} =>
  isVariantDefinition(definition)
    ? {
        tag: definition.tag,
        fields: definition.fields,
      }
    : {
        tag: name,
        fields: definition,
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
 */
// eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
export interface TaggedEnumClassVariant<Tag extends string, F extends VariantFields>
  // eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
  extends Schema.Codec<
    Schema.Struct.Type<F> & { readonly _tag: Tag },
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
  ): Schema.Struct.Type<F> & { readonly _tag: Tag }
}

type TaggedEnumType<V extends VariantsMap> = {
  readonly [K in keyof V & string]: Schema.Struct.Type<VariantFieldsOf<V[K]>> & {
    readonly _tag: VariantWireTagOf<K, V[K]>
  }
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
    VariantFieldsOf<V[K]>
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

export interface TaggedEnumClassFactory {
  <const V extends VariantsMap>(
    identifier: string,
    variants: TaggedEnumClassInput<V>,
  ): TaggedEnumClass<V>
  readonly variant: typeof makeVariantDefinition
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

    const { tag, fields } = getVariantConfig(memberName, definition)
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

  const guards = Object.fromEntries(
    Object.entries(variantClasses).map(([memberName, variant]) => [memberName, Schema.is(variant)]),
  )
  const isAnyOf = (members: ReadonlyArray<string>) => {
    const allowed = new Set(members)
    return (u: unknown): boolean => {
      if (typeof u !== "object" || u === null || !("_tag" in u)) return false
      const tag = (u as { readonly _tag?: unknown })._tag
      return typeof tag === "string" && allowed.has(wireTagToMember.get(tag) ?? "")
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
})
