/**
 * `Schema.TaggedEnumClass` — a single-call factory for discriminated unions.
 *
 * Wraps `Schema.Union([...TaggedClass]).pipe(Schema.toTaggedUnion("_tag"))`
 * (Effect 4 ships both primitives — `Schema.Union` and the `toTaggedUnion`
 * pipe — and their composition keeps `instanceof` working through decode,
 * confirmed via runtime probe). The wrapper adds:
 *
 * - per-variant TaggedClass constructors under `cases` (so callers write
 *   `MyEnum.cases.Variant.make({...})`);
 * - per-variant TaggedClass identity (so `instanceof MyEnum.cases.Variant`
 *   works on decoded values — guaranteed because `toTaggedUnion`
 *   preserves the original member schemas inside `cases`);
 * - construction-time rejection of empty variant maps, `_tag` payload
 *   field collisions, and the prototype-special `__proto__` variant tag.
 *
 * The wire format is identical to the existing per-variant
 * `Schema.TaggedClass` shape: `{ _tag: "Variant", ...fields }`. SQLite +
 * transport are unaffected by the migration.
 *
 * Discriminator is locked to `_tag`. Migrating any `_kind` consumers (the
 * `Contribution` union) to `_tag` happens in C8 alongside the
 * `definePackage` rewrite.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
 *
 * export const Shape = TaggedEnumClass("Shape", {
 *   Circle: { radius: Schema.Number },
 *   Rectangle: { width: Schema.Number, height: Schema.Number },
 * })
 * export type Shape = Schema.Schema.Type<typeof Shape>
 *
 * // Construction
 * const c = Shape.cases.Circle.make({ radius: 5 })
 *
 * // instanceof works
 * c instanceof Shape.cases.Circle  // true
 *
 * // Decode + encode round-trip
 * const decoded = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 5 })
 * decoded instanceof Shape.cases.Circle  // true
 *
 * // Pattern matching (exhaustive at compile time)
 * const area = Shape.match({
 *   Circle:    (c) => Math.PI * c.radius ** 2,
 *   Rectangle: (r) => r.width * r.height,
 * })(c)
 * ```
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
 * Map of variant tag → field schemas.
 */
export type VariantsMap = Record<string, VariantFields>

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

export type ReservedVariantTag = "__proto__"

export type AssertNoReservedTags<V extends VariantsMap> = {
  readonly [K in keyof V]: K extends ReservedVariantTag
    ? {
        readonly __error: "TaggedEnumClass: variant tag collides with JavaScript prototype semantics."
      }
    : V[K]
}

/**
 * Defect raised at construction time when the variant map violates the
 * factory's preconditions. These are programmer errors, not user-input
 * errors — they surface as a thrown defect at module-load time so the
 * type-level checks are not the only safety net. Modeled as a
 * `TaggedErrorClass` per the repo-wide error discipline (every error has
 * a discriminator + Schema), even though the runtime path here throws
 * synchronously rather than failing through Effect's typed channel.
 */
export class TaggedEnumClassConfigError extends Schema.TaggedErrorClass<TaggedEnumClassConfigError>()(
  "TaggedEnumClassConfigError",
  {
    message: Schema.String,
  },
) {}

/**
 * Build a per-variant `Schema.TaggedClass`. The class identity is unique
 * to this call (each `Schema.TaggedClass<Self>()` invocation produces a
 * distinct class), and the schema id namespaces the variant under the
 * enum identifier so two TaggedEnums that share a variant name have
 * distinct schema brands.
 *
 * The `Self = unknown` choice (rather than the more common pattern of
 * passing the class type as `Self`) is deliberate: at the factory layer
 * we don't have a hand-named class to reference, so we let `TaggedClass`
 * synthesize the identity. Callers see the variant as
 * `MyEnum.cases.Variant` — the enum-level access path provides the
 * nominal surface; the underlying class identity is an implementation detail.
 */
const buildVariantClass = <Tag extends string, F extends VariantFields>(
  identifier: string,
  tag: Tag,
  fields: F,
): TaggedEnumClassVariant<Tag, F> => {
  const schemaId = `${identifier}/${tag}`
  // Empty class body — TaggedClass returns the class constructor, which
  // we keep as-is. No methods at v1; module-level functions only.
  // The `Self = {}` placeholder satisfies TaggedClass's generic signature
  // without forcing the caller to name the class type.
  const variant = Schema.TaggedClass<Schema.Struct.Type<F> & { readonly _tag: Tag }>(schemaId)(
    tag,
    fields,
  )
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return variant as unknown as TaggedEnumClassVariant<Tag, F>
}

/**
 * Per-variant TaggedClass schema. Self-typed via a recursive interface so the
 * class instance properties match the field shape (`Schema.Schema.Type<F>`)
 * AND the constructor call shape (`MyEnum.cases.Variant.make({...fields})`). The
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
  // be omitted (`MyEnum.cases.Variant.make()`), and `MakeOptions` (validation
  // toggles) is accepted as a second argument.
  new (
    ...args: Record<string, never> extends Schema.Struct.MakeIn<F>
      ? [props?: Schema.Struct.MakeIn<F>, options?: Schema.MakeOptions]
      : [props: Schema.Struct.MakeIn<F>, options?: Schema.MakeOptions]
  ): Schema.Struct.Type<F> & { readonly _tag: Tag }
}

/**
 * The TaggedEnumClass result. Combines:
 *
 * - the underlying tagged-union schema (decode/encode/AST) typed via
 *   `Schema.Codec<Type, Encoded, DecodingServices, EncodingServices>` so
 *   field-level service requirements are preserved across the union — a
 *   variant whose field schemas require a service propagates that service
 *   to consumers' `R` channel rather than silently being erased to
 *   `never`;
 * - per-variant TaggedClasses under `cases` (`MyEnum.cases.Variant`);
 * - the `cases` / `guards` / `isAnyOf` / `match` augmentation from
 *   Effect's `Schema.toTaggedUnion("_tag")` (typed loosely — the runtime
 *   surface is real but the precise generic shape is awkward to express
 *   without referencing internals).
 */
// eslint-disable-next-line import/namespace -- Schema namespace exposes type members oxlint cannot prove
export type TaggedEnumClass<V extends VariantsMap> = Schema.Codec<
  { readonly [K in keyof V]: Schema.Struct.Type<V[K]> & { readonly _tag: K } }[keyof V],
  { readonly [K in keyof V]: Schema.Struct.Encoded<V[K]> & { readonly _tag: K } }[keyof V],
  { [K in keyof V]: Schema.Struct.DecodingServices<V[K]> }[keyof V],
  { [K in keyof V]: Schema.Struct.EncodingServices<V[K]> }[keyof V]
> & {
  // The `Schema.toTaggedUnion("_tag")` augmentation. Typed loosely because the
  // exact shape requires Effect-internal types that aren't re-exported. The
  // runtime values are real and behave per Effect's docs.
  readonly cases: { readonly [K in keyof V & string]: TaggedEnumClassVariant<K, V[K]> }
  readonly guards: {
    readonly [K in keyof V & string]: (
      u: unknown,
    ) => u is Schema.Struct.Type<V[K]> & { readonly _tag: K }
  }
  readonly isAnyOf: <const Tags extends ReadonlyArray<keyof V & string>>(
    tags: Tags,
  ) => (u: unknown) => u is {
    readonly [K in Tags[number]]: Schema.Struct.Type<V[K]> & { readonly _tag: K }
  }[Tags[number]]
  readonly match: {
    // Curried: `match(handlers)(value)`. Inferred return type unifies all
    // handler returns rather than collapsing to a single forced `Out`.
    <
      Handlers extends {
        readonly [K in keyof V & string]: (
          v: Schema.Struct.Type<V[K]> & { readonly _tag: K },
        ) => unknown
      },
    >(
      handlers: Handlers,
    ): (
      v: { readonly [K in keyof V]: Schema.Struct.Type<V[K]> & { readonly _tag: K } }[keyof V],
    ) => ReturnType<Handlers[keyof Handlers]>
    // Uncurried: `match(value, handlers)`. Same inference behavior.
    <
      Handlers extends {
        readonly [K in keyof V & string]: (
          v: Schema.Struct.Type<V[K]> & { readonly _tag: K },
        ) => unknown
      },
    >(
      v: { readonly [K in keyof V]: Schema.Struct.Type<V[K]> & { readonly _tag: K } }[keyof V],
      handlers: Handlers,
    ): ReturnType<Handlers[keyof Handlers]>
  }
}

/**
 * Build a `Schema.TaggedEnumClass` from a name and a map of variant
 * tag → field schemas.
 *
 * The `identifier` is used as the schema-id prefix for each variant
 * (`${identifier}/${tag}`) so two TaggedEnumClasses with overlapping
 * variant names produce distinct branded schemas.
 *
 * @throws if the variant map is empty, contains a `_tag` payload field,
 *   or uses a reserved variant tag name. These are programmer errors
 *   detected at module-load time.
 */
export const TaggedEnumClass = <V extends VariantsMap>(
  identifier: string,
  variants: V & {
    readonly [K in keyof V]: K extends ReservedVariantTag
      ? {
          readonly __error: "TaggedEnumClass: variant tag collides with a reserved key on the wrapper or Schema.toTaggedUnion augmentation."
        }
      : "_tag" extends keyof V[K]
        ? {
            readonly __error: "TaggedEnumClass: variant fields may not contain a `_tag` key (collides with the discriminator)."
          }
        : V[K]
  },
): TaggedEnumClass<V> => {
  // Runtime validation — defense in depth above the type-level guards.
  const variantEntries = Object.entries(variants)
  if (variantEntries.length === 0) {
    throw new TaggedEnumClassConfigError({
      message: `TaggedEnumClass: "${identifier}" was constructed with no variants — the union would be uninhabited.`,
    })
  }
  for (const [tag, fields] of variantEntries) {
    if (tag === "__proto__") {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${tag}" collides with JavaScript prototype semantics.`,
      })
    }
    if (Object.prototype.hasOwnProperty.call(fields, "_tag")) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${tag}" declares a "_tag" field — Effect's TaggedClass would let the payload override the discriminator literal. Remove the field; the discriminator is implicit.`,
      })
    }
  }

  // Build per-variant TaggedClasses.
  // `Object.create(null)` (no prototype) avoids the `__proto__` footgun:
  // assigning to `obj.__proto__` on a plain `{}` mutates the prototype
  // instead of creating an own property, silently dropping the variant
  // from `Object.values(...)`. The runtime guard above rejects `__proto__`
  // explicitly; this is belt + suspenders.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const variantClasses = Object.create(null) as Record<
    string,
    Schema.Top & { readonly Type: { readonly _tag: string } }
  >
  for (const [tag, fields] of variantEntries) {
    variantClasses[tag] = buildVariantClass(identifier, tag, fields)
  }

  // Build the union from the variant classes, then pipe through
  // `toTaggedUnion("_tag")` to attach `cases`/`guards`/`isAnyOf`/`match`.
  const members = Object.values(variantClasses)
  const union = Schema.Union(members).pipe(Schema.toTaggedUnion("_tag"))

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return union as unknown as TaggedEnumClass<V>
}
