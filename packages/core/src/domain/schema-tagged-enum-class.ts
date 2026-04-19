/**
 * `Schema.TaggedEnumClass` — a single-call factory for discriminated unions.
 *
 * Wraps `Schema.Union([...TaggedClass]).pipe(Schema.toTaggedUnion("_tag"))`
 * (Effect 4 ships both primitives — `Schema.Union` and the `toTaggedUnion`
 * pipe — and their composition keeps `instanceof` working through decode,
 * confirmed via runtime probe). The wrapper adds:
 *
 * - per-variant smart constructors as top-level properties (so callers
 *   write `MyEnum.Variant({...})` instead of
 *   `MyEnum.cases.Variant.make({...})`);
 * - per-variant TaggedClass identity (so `instanceof MyEnum.Variant`
 *   works on decoded values — guaranteed because `toTaggedUnion`
 *   preserves the original member schemas inside `cases`);
 * - construction-time rejection of empty variant maps, `_tag` payload
 *   field collisions, and variant tag names that collide with the
 *   wrapper's own own properties (`cases`, `match`, `guards`,
 *   `isAnyOf`, plus the inherited Schema/Bottom keys).
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
 *   Circle:    { radius: Schema.Number },
 *   Rectangle: { width: Schema.Number, height: Schema.Number },
 * })
 * export type Shape = Schema.Schema.Type<typeof Shape>
 *
 * // Construction
 * const c = new Shape.Circle({ radius: 5 })
 * // or via the schema's `.make`
 * const c2 = Shape.cases.Circle.make({ radius: 5 })
 *
 * // instanceof works
 * c instanceof Shape.Circle  // true
 *
 * // Decode + encode round-trip
 * const decoded = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 5 })
 * decoded instanceof Shape.Circle  // true
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

/**
 * Names that the wrapper attaches to the merged shape and Effect's
 * `toTaggedUnion` augmentation also installs. Variant tag names that match
 * any of these would shadow the wrapper's own surface — reject at the
 * type level and at runtime.
 *
 * Note: this is about VARIANT TAG NAMES, not payload field names. A
 * payload field named `cases` is fine (it lives on instances). A variant
 * tag named `cases` would collide with `Shape.cases`.
 */
export type ReservedVariantTag =
  | "cases"
  | "guards"
  | "isAnyOf"
  | "match"
  | "members"
  | "ast"
  | "pipe"
  | "make"
  | "makeSync"
  | "annotate"
  | "annotations"
  | "Type"
  | "Encoded"

export type AssertNoReservedTags<V extends VariantsMap> = {
  readonly [K in keyof V]: K extends ReservedVariantTag
    ? {
        readonly __error: "TaggedEnumClass: variant tag collides with a reserved key on the wrapper or Schema.toTaggedUnion augmentation."
      }
    : V[K]
}

const RESERVED_TAGS: ReadonlySet<string> = new Set<ReservedVariantTag>([
  "cases",
  "guards",
  "isAnyOf",
  "match",
  "members",
  "ast",
  "pipe",
  "make",
  "makeSync",
  "annotate",
  "annotations",
  "Type",
  "Encoded",
])

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
 * `MyEnum.Variant` — the enum-level access path provides the nominal
 * surface; the underlying class identity is an implementation detail.
 */
const buildVariantClass = (
  identifier: string,
  tag: string,
  fields: VariantFields,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => {
  const schemaId = `${identifier}/${tag}`
  // Empty class body — TaggedClass returns the class constructor, which
  // we keep as-is. No methods at v1; module-level functions only.
  // The `Self = {}` placeholder satisfies TaggedClass's generic signature
  // without forcing the caller to name the class type.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
  return Schema.TaggedClass<any>(schemaId)(tag, fields)
}

/**
 * Per-variant TaggedClass schema. Self-typed via a recursive interface so the
 * class instance properties match the field shape (`Schema.Schema.Type<F>`)
 * AND the constructor call shape (`new MyEnum.Variant({...fields})`). The
 * `_tag` literal is added by `Schema.TaggedClass` and is not part of `F`.
 */
// eslint-disable-next-line import/namespace
export interface TaggedEnumClassVariant<Tag extends string, F extends VariantFields>
  // eslint-disable-next-line import/namespace
  extends Schema.Codec<
    Schema.Struct.Type<F> & { readonly _tag: Tag },
    Schema.Struct.Encoded<F> & { readonly _tag: Tag }
  > {
  new (props: Schema.Struct.Type<F>): Schema.Struct.Type<F> & { readonly _tag: Tag }
}

/**
 * The TaggedEnumClass result. Combines:
 *
 * - the underlying tagged-union schema (decode/encode/AST) typed via
 *   `Schema.Codec<Type, Encoded>` so consumers see a fully-resolved
 *   schema (no leaking generic poisoning the requirements channel of
 *   downstream Effect chains);
 * - per-variant TaggedClasses as own properties (`MyEnum.Variant`);
 * - the `cases` / `guards` / `isAnyOf` / `match` augmentation from
 *   Effect's `Schema.toTaggedUnion("_tag")` (typed loosely — the runtime
 *   surface is real but the precise generic shape is awkward to express
 *   without referencing internals).
 */
// eslint-disable-next-line import/namespace
export type TaggedEnumClass<V extends VariantsMap> = Schema.Codec<
  { readonly [K in keyof V]: Schema.Struct.Type<V[K]> & { readonly _tag: K } }[keyof V],
  { readonly [K in keyof V]: Schema.Struct.Encoded<V[K]> & { readonly _tag: K } }[keyof V]
> & {
  readonly [K in keyof V & string]: TaggedEnumClassVariant<K, V[K]>
} & {
  // The `Schema.toTaggedUnion("_tag")` augmentation. Typed loosely because the
  // exact shape requires Effect-internal types that aren't re-exported. The
  // runtime values are real and behave per Effect's docs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly cases: { readonly [K in keyof V & string]: any }
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
  readonly match: <Out>(handlers: {
    readonly [K in keyof V & string]: (v: Schema.Struct.Type<V[K]> & { readonly _tag: K }) => Out
  }) => (
    v: { readonly [K in keyof V]: Schema.Struct.Type<V[K]> & { readonly _tag: K } }[keyof V],
  ) => Out
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
    if (RESERVED_TAGS.has(tag)) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${tag}" collides with a reserved key on the wrapper / Schema.toTaggedUnion augmentation. Reserved: ${[
          ...RESERVED_TAGS,
        ].join(", ")}.`,
      })
    }
    if (Object.prototype.hasOwnProperty.call(fields, "_tag")) {
      throw new TaggedEnumClassConfigError({
        message: `TaggedEnumClass: "${identifier}" variant "${tag}" declares a "_tag" field — Effect's TaggedClass would let the payload override the discriminator literal. Remove the field; the discriminator is implicit.`,
      })
    }
  }

  // Build per-variant TaggedClasses.
  const variantClasses: Record<string, unknown> = {}
  for (const [tag, fields] of variantEntries) {
    variantClasses[tag] = buildVariantClass(identifier, tag, fields)
  }

  // Build the union from the variant classes, then pipe through
  // `toTaggedUnion("_tag")` to attach `cases`/`guards`/`isAnyOf`/`match`.
  // Effect's runtime adds those as own properties on the schema, so they
  // survive the subsequent `Object.assign` (which only adds the per-variant
  // class shorthand and never collides with the augmentation keys —
  // RESERVED_TAGS guards exactly that).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
  const members = Object.values(variantClasses) as ReadonlyArray<any>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
  const union = Schema.Union(members).pipe(Schema.toTaggedUnion("_tag" as any))

  // Attach the per-variant classes as own properties so `MyEnum.Variant`
  // works as a top-level construction surface alongside the
  // `MyEnum.cases.Variant` path that Effect already provides.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return Object.assign(union, variantClasses) as unknown as TaggedEnumClass<V>
}
