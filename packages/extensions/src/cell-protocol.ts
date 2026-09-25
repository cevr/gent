import { Effect, Option, Predicate, Result, Schema } from "effect"
import { types } from "node:util"

// ── value reader ────────────────────────────────────────────────────────────

/**
 * A cell runs in full Bun, in the same realm as the worker that reads its
 * values. A getter, a Proxy trap, `toString` or `Symbol.toPrimitive` that a
 * read reaches is cell code, and cell code may loop or throw. This reader
 * reads a value without running any of it:
 *
 * - It reads properties through their descriptors: a data value, or a host
 *   getter from `hostGetters`, compared by identity.
 * - It never touches a Proxy. Bun's `util.types.isProxy` reads the engine's
 *   own proxy mark; no trap runs, so no Proxy can fake the answer.
 * - It checks a built-in's brand with `util.types`, which reads the internal
 *   slot, and reads the value through the prototype functions this module
 *   saves when it loads, before any cell runs. Each one reads that slot, so a
 *   subclass getter or a replaced prototype method is never called.
 *
 * The snapshot codec and the worker's error renderer read through it.
 */
const isProxy = types.isProxy
const isNativeError = types.isNativeError
const isRegExp = types.isRegExp
const isDate = types.isDate
const isMap = types.isMap
const isSet = types.isSet
const isTypedArray = types.isTypedArray
const ownDescriptor = Object.getOwnPropertyDescriptor
const prototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys
const hasOwn = Object.hasOwn
const apply = Reflect.apply
const isArray = Array.isArray

/** The getter a descriptor holds; none for a data property. */
const descriptorGetter = (descriptor: PropertyDescriptor) =>
  Option.liftPredicate(Reflect.get(descriptor, "get"), Predicate.isFunction)

/** An intrinsic accessor's getter, taken now. */
// oxlint-disable-next-line effect/noObjectParameters -- intrinsic prototypes are saved as plain objects when the module loads
const intrinsicGetter = (prototype: object, key: PropertyKey) =>
  Option.flatMap(Option.fromUndefinedOr(ownDescriptor(prototype, key)), descriptorGetter)

/** An intrinsic method, taken now. */
// oxlint-disable-next-line effect/noObjectParameters -- intrinsic prototypes are saved as plain objects when the module loads
const intrinsicMethod = (prototype: object, key: PropertyKey) =>
  Option.flatMap(Option.fromUndefinedOr(ownDescriptor(prototype, key)), (descriptor) =>
    Option.liftPredicate(Reflect.get(descriptor, "value"), Predicate.isFunction),
  )

const typedArrayPrototype: object = prototypeOf(Uint8Array.prototype)
const dateTime = intrinsicMethod(Date.prototype, "getTime")
const mapForEach = intrinsicMethod(Map.prototype, "forEach")
const setForEach = intrinsicMethod(Set.prototype, "forEach")
const mapSize = intrinsicGetter(Map.prototype, "size")
const setSize = intrinsicGetter(Set.prototype, "size")
const typedArrayKind = intrinsicGetter(typedArrayPrototype, Symbol.toStringTag)
const typedArrayLength = intrinsicGetter(typedArrayPrototype, "length")
const regExpSource = intrinsicGetter(RegExp.prototype, "source")
/**
 * `RegExp.prototype.flags` reads `this.global` and the other flag getters by
 * name, so a subclass getter runs; each flag getter reads the internal slot.
 * Spec order, and only the flags this Bun knows.
 */
const regExpFlagKeys: ReadonlyArray<readonly [string, string]> = [
  ["d", "hasIndices"],
  ["g", "global"],
  ["i", "ignoreCase"],
  ["m", "multiline"],
  ["s", "dotAll"],
  ["u", "unicode"],
  ["v", "unicodeSets"],
  ["y", "sticky"],
]
const regExpFlags = regExpFlagKeys.flatMap(([flag, key]) =>
  Option.toArray(Option.map(intrinsicGetter(RegExp.prototype, key), (get) => ({ flag, get }))),
)

/**
 * The host getters a property read runs: those on the prototype of every
 * error type the realm defines as a global, `Error` included. Bun keeps a
 * `DOMException`'s name and message, and a `BuildMessage`'s position, behind
 * such getters. Taken when the module loads, before any cell runs, from data
 * globals only. A closed set compared by identity: a cell's own getter, a
 * bound one that prints as native code included, is never in it.
 */
const errorPrototype: object = Error.prototype
const hostGetters: ReadonlySet<unknown> = new Set(
  Object.getOwnPropertyNames(globalThis)
    .flatMap((name) =>
      Option.toArray(
        Option.fromUndefinedOr(ownDescriptor(globalThis, name)).pipe(
          Option.flatMap((descriptor) =>
            Option.liftPredicate(Reflect.get(descriptor, "value"), Predicate.isFunction),
          ),
          Option.flatMap((type) =>
            Option.liftPredicate(Reflect.get(type, "prototype"), Predicate.isObjectKeyword),
          ),
          Option.filter(
            (prototype) =>
              prototype === errorPrototype ||
              Object.prototype.isPrototypeOf.call(errorPrototype, prototype),
          ),
        ),
      ),
    )
    .flatMap((prototype) =>
      Object.values(Object.getOwnPropertyDescriptors(prototype)).flatMap((descriptor) =>
        Option.toArray(descriptorGetter(descriptor)),
      ),
    ),
)

/** Prototype links a read follows before it gives up. */
const PROTOTYPE_DEPTH_LIMIT = 32

/** A read that would run cell code: a Proxy on the path, or a getter the cell wrote. */
class UnreadableValue extends Schema.TaggedError<UnreadableValue>()("UnreadableValue", {}) {}
/** A read the reader made, or `UnreadableValue` where making it would run cell code. */
type ValueRead<A> = Result.Result<A, UnreadableValue>
const unreadable: ValueRead<never> = Result.fail(new UnreadableValue())

/** A property found along the prototype chain, running only the getters in `getters`. */
const readThrough =
  (getters: ReadonlySet<unknown>) =>
  // oxlint-disable-next-line effect/noObjectParameters -- a cell value has any JavaScript shape; descriptors read it without running its getters
  (target: object, key: string): ValueRead<Option.Option<unknown>> => {
    let holder: unknown = target
    for (let depth = 0; depth < PROTOTYPE_DEPTH_LIMIT; depth++) {
      if (!Predicate.isObjectKeyword(holder)) return Result.succeed(Option.none())
      if (isProxy(holder)) return unreadable
      const descriptor = ownDescriptor(holder, key)
      if (Predicate.isNotUndefined(descriptor)) {
        if (hasOwn(descriptor, "value")) return Result.succeed(Option.some(descriptor.value))
        const get = descriptorGetter(descriptor)
        if (Option.isSome(get) && getters.has(get.value))
          return Result.succeed(Option.some(apply(get.value, target, [])))
        return unreadable
      }
      holder = prototypeOf(holder)
    }
    return unreadable
  }

/**
 * A property found along the prototype chain; none when absent. A getter
 * runs only when the host provides it, and a host getter can still throw.
 */
export const readProperty = readThrough(hostGetters)

/** A property held as data along the prototype chain; no getter runs, a host one included. */
export const readDataProperty = readThrough(new Set())

/** Whether `prototype` is on a value's prototype chain, as `instanceof` asks, with no trap run. */
// oxlint-disable-next-line effect/noUnknownParameters, effect/noObjectParameters -- a cell value has any JavaScript shape; the chain is walked without running its traps
export const inheritsFrom = (value: unknown, prototype: object): ValueRead<boolean> => {
  if (!Predicate.isObjectKeyword(value)) return Result.succeed(false)
  let holder: unknown = value
  for (let depth = 0; depth < PROTOTYPE_DEPTH_LIMIT; depth++) {
    if (!Predicate.isObjectKeyword(holder)) return Result.succeed(false)
    if (isProxy(holder)) return unreadable
    holder = prototypeOf(holder)
    if (holder === prototype) return Result.succeed(true)
  }
  return unreadable
}

/** An array that is not a Proxy: its length and elements read without traps. */
// oxlint-disable-next-line effect/noUnknownParameters -- a cell value has any JavaScript shape
export const isOrdinaryArray = (value: unknown): value is ReadonlyArray<unknown> =>
  !isProxy(value) && isArray(value)

// ── namespace snapshot codec ────────────────────────────────────────────────

/**
 * Namespace snapshots move cell bindings between a worker and the host as
 * tagged JSON. The worker encodes in its own realm through the value reader,
 * so encoding never runs cell code; brand checks read internal slots, so they
 * hold for a value from any realm. The reviver runs inside the realm that
 * restores, so restored dates, maps, sets, and errors carry its intrinsics.
 */
export const maximumSnapshotBindingBytes = 256 * 1024
const maximumSnapshotBytes = 768 * 1024
const maximumSnapshotDepth = 64
/** Each entry encodes to at least two bytes, so a longer collection is too large unread. */
const maximumSnapshotEntries = maximumSnapshotBindingBytes / 2

const SnapshotOmission = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literals(["function", "unsupported", "cyclic", "too-deep", "too-large"]),
})
type SnapshotOmission = typeof SnapshotOmission.Type
type OmissionReason = SnapshotOmission["reason"]

export const SnapshotBinding = Schema.Struct({ name: Schema.String, value: Schema.Json })
export type SnapshotBinding = typeof SnapshotBinding.Type

export const CellSnapshot = Schema.Struct({
  bindings: Schema.Array(SnapshotBinding),
  omitted: Schema.Array(SnapshotOmission),
})
export type CellSnapshot = typeof CellSnapshot.Type

const TAG = "$gent"

/** A value that cannot round-trip. It never enters the encoded JSON. */
class Omitted {
  constructor(readonly reason: OmissionReason) {}
}
type Encoded = Schema.Json | Omitted
const isOmitted = (value: Encoded): value is Omitted => value instanceof Omitted
const unsupported = new Omitted("unsupported")
const tooLarge = new Omitted("too-large")
/** Unreadable is unsupported: the value cannot be read without running cell code. */
const whenRead = <A>(read: ValueRead<A>, encode: (value: A) => Encoded): Encoded =>
  Result.match(read, { onFailure: () => unsupported, onSuccess: encode })

const tagged = (kind: string, value: Schema.Json): Schema.Json => ({ [TAG]: kind, value })

/** Plain means its prototype is null or a root Object.prototype from any realm. */
// oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const isPlainObject = (value: object) => {
  const proto: unknown = prototypeOf(value)
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  if (proto === null) return true
  if (!Predicate.isObjectKeyword(proto) || isProxy(proto)) return false
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return prototypeOf(proto) === null
}

const typedArrayKinds = new Set([
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "Uint8ClampedArray",
  "BigInt64Array",
  "BigUint64Array",
])

// oxlint-disable-next-line effect/noNullish, effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodePrimitive = (value: unknown): Encoded | undefined => {
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  if (Predicate.isUndefined(value)) return tagged("undefined", null)
  if (Predicate.isNumber(value)) {
    if (Number.isFinite(value)) return value
    return tagged("number", String(value))
  }
  if (Predicate.isBigInt(value)) return tagged("bigint", value.toString())
  if (Predicate.isFunction(value)) return new Omitted("function")
  if (!Predicate.isObjectKeyword(value)) return unsupported
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return undefined
}

// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeList = (items: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  const out: Schema.Json[] = []
  for (const item of items) {
    const encoded = inner(item)
    if (isOmitted(encoded)) return encoded
    out.push(encoded)
  }
  return out
}

const ownProperty = (value: Schema.Json): PropertyDescriptor => ({
  value,
  writable: true,
  enumerable: true,
  configurable: true,
})

/** An array's elements through their descriptors; a hole reads as undefined. */
// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeArray = (array: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  // An array's own length is a data property: no getter can stand in for it.
  if (array.length > maximumSnapshotEntries) return tooLarge
  const out: Schema.Json[] = []
  for (let index = 0; index < array.length; index++) {
    const encoded = whenRead(readProperty(array, String(index)), (item) =>
      inner(Option.getOrUndefined(item)),
    )
    if (isOmitted(encoded)) return encoded
    out.push(encoded)
  }
  return out
}

/** A plain object's own enumerable string keys, in `Object.entries` order; any accessor is cell code. */
// oxlint-disable-next-line effect/noUnknownParameters, effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeRecord = (object: object, inner: (item: unknown) => Encoded): Encoded => {
  const keys = ownKeys(object)
  if (keys.length > maximumSnapshotEntries) return tooLarge
  const out: Record<string, Schema.Json> = {}
  for (const key of keys) {
    if (!Predicate.isString(key)) continue
    const descriptor = ownDescriptor(object, key)
    if (Predicate.isUndefined(descriptor) || descriptor.enumerable !== true) continue
    if (!hasOwn(descriptor, "value")) return unsupported
    const encoded = inner(descriptor.value)
    if (isOmitted(encoded)) return encoded
    // Assignment to an own `__proto__` key would set the prototype and drop the key.
    Object.defineProperty(out, key, ownProperty(encoded))
  }
  if (hasOwn(out, TAG)) return tagged("object", out)
  return out
}

/** A native error's `name`, `message` or `stack`: a primitive as text, absent as the fallback. */
// oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const errorText = (error: object, key: string, fallback: string): ValueRead<string> =>
  Result.flatMap(readProperty(error, key), (found) => {
    if (Option.isNone(found)) return Result.succeed(fallback)
    // String() of an object runs its toString or Symbol.toPrimitive: cell code.
    if (Predicate.isObjectKeyword(found.value)) return unreadable
    return Result.succeed(String(found.value))
  })

// oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeError = (error: object): Encoded =>
  whenRead(errorText(error, "name", "Error"), (name) =>
    whenRead(errorText(error, "message", ""), (message) =>
      whenRead(errorText(error, "stack", ""), (stack) => tagged("error", { name, message, stack })),
    ),
  )

/** A saved intrinsic called on a value; none when this Bun lacks it. */
const intrinsic = (
  fn: Option.Option<Function>,
  // oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  target: object,
  args: ReadonlyArray<unknown> = [],
): Option.Option<unknown> => Option.map(fn, (call) => apply(call, target, args))

// oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeRegExp = (value: object): Encoded => {
  const source = Option.filter(intrinsic(regExpSource, value), Predicate.isString)
  if (Option.isNone(source)) return unsupported
  const flags = regExpFlags
    .filter(({ get }) => apply(get, value, []) === true)
    .map(({ flag }) => flag)
    .join("")
  return tagged("regexp", [source.value, flags])
}

/**
 * A Map's or Set's members through its saved `size` getter and `forEach`,
 * which walk the internal table, so a subclass iterator never runs.
 */
const encodeCollection = (
  // oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  value: object,
  collection: {
    readonly size: Option.Option<Function>
    readonly forEach: Option.Option<Function>
  },
  // oxlint-disable-next-line effect/noUnknownParameters -- collection members have any JavaScript shape
  encodeMember: (item: unknown, key: unknown) => Encoded,
): Encoded => {
  const size = Option.filter(intrinsic(collection.size, value), Predicate.isNumber)
  if (Option.isNone(size)) return unsupported
  if (size.value > maximumSnapshotEntries) return tooLarge
  const members: Array<readonly [unknown, unknown]> = []
  const walked = intrinsic(collection.forEach, value, [
    // oxlint-disable-next-line effect/noUnknownParameters -- collection members have any JavaScript shape
    (item: unknown, key: unknown) => members.push([item, key]),
  ])
  if (Option.isNone(walked)) return unsupported
  return encodeList(members, (member) => {
    if (!isOrdinaryArray(member)) return unsupported
    return encodeMember(member[0], member[1])
  })
}

const encodeTypedArray = (value: NodeJS.TypedArray): Encoded => {
  const kind = Option.filter(intrinsic(typedArrayKind, value), Predicate.isString)
  const length = Option.filter(intrinsic(typedArrayLength, value), Predicate.isNumber)
  if (Option.isNone(kind) || Option.isNone(length) || !typedArrayKinds.has(kind.value))
    return unsupported
  if (length.value > maximumSnapshotEntries) return tooLarge
  // An integer index on a typed array reads its buffer and never its prototype.
  const values: Schema.Json[] = []
  for (let index = 0; index < length.value; index++) {
    const item = value[index]
    // Bigint elements travel as strings.
    if (Predicate.isBigInt(item)) values.push(item.toString())
    else if (Predicate.isNumber(item)) values.push(item)
  }
  return tagged(kind.value, values)
}

/** Wrap a member list under its tag; an omitted member omits the whole value. */
const taggedList = (kind: string, encoded: Encoded): Encoded => {
  if (isOmitted(encoded)) return encoded
  return tagged(kind, encoded)
}

/**
 * Built-ins by brand. A brand check reads the internal slot, and the read
 * uses a prototype function saved at load, so a subclass override never runs.
 */
// oxlint-disable-next-line effect/noNullish, effect/noUnknownParameters, effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeBuiltin = (value: object, inner: (item: unknown) => Encoded): Encoded | undefined => {
  if (isNativeError(value)) return encodeError(value)
  if (isDate(value))
    return Option.match(Option.filter(intrinsic(dateTime, value), Predicate.isNumber), {
      onNone: () => unsupported,
      onSome: (time) => tagged("date", time),
    })
  if (isRegExp(value)) return encodeRegExp(value)
  if (isMap(value))
    return taggedList(
      "map",
      encodeCollection(value, { size: mapSize, forEach: mapForEach }, (item, key) =>
        encodeList([key, item], inner),
      ),
    )
  if (isSet(value))
    return taggedList(
      "set",
      encodeCollection(value, { size: setSize, forEach: setForEach }, (item) => inner(item)),
    )
  if (isTypedArray(value)) return encodeTypedArray(value)
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return undefined
}

// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeValue = (value: unknown, depth: number, seen: Set<object>): Encoded => {
  if (depth > maximumSnapshotDepth) return new Omitted("too-deep")
  const primitive = encodePrimitive(value)
  if (!Predicate.isUndefined(primitive)) return primitive
  // Every trap of a Proxy is cell code, and no read of one is safe.
  if (!Predicate.isObjectKeyword(value) || isProxy(value)) return unsupported
  const object: object = value
  if (seen.has(object)) return new Omitted("cyclic")
  seen.add(object)
  // oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  const inner = (child: unknown) => encodeValue(child, depth + 1, seen)
  let encoded: Encoded
  const builtin = encodeBuiltin(object, inner)
  if (!Predicate.isUndefined(builtin)) encoded = builtin
  else if (isArray(object)) encoded = encodeArray(object, inner)
  else if (isPlainObject(object)) encoded = encodeRecord(object, inner)
  else encoded = unsupported
  seen.delete(object)
  return encoded
}

// oxlint-disable-next-line effect/noGlobals -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const jsonBytes = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/**
 * One binding's encoding. Encoding runs no cell code; a host getter can still
 * throw, and that value cannot round-trip either.
 */
const encodeBinding = Option.liftThrowable(
  // oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  (value: unknown): Encoded => encodeValue(value, 0, new Set()),
)

/** Encode every binding. Values that cannot round-trip are named with the reason, never silently dropped. */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>): CellSnapshot => {
  const bindings: SnapshotBinding[] = []
  const omitted: SnapshotOmission[] = []
  let total = 0
  for (const [name, value] of namespace) {
    const encoded = Option.getOrElse(encodeBinding(value), () => unsupported)
    if (isOmitted(encoded)) {
      omitted.push({ name, reason: encoded.reason })
      continue
    }
    const size = jsonBytes(encoded)
    if (size > maximumSnapshotBindingBytes || total + size > maximumSnapshotBytes) {
      omitted.push({ name, reason: "too-large" })
      continue
    }
    total += size
    bindings.push({ name, value: encoded })
  }
  return { bindings, omitted }
}

// oxlint-disable-next-line effect/noGlobals -- the reviver source embeds the tag as a JavaScript literal
const TAG_LITERAL = JSON.stringify(TAG)

/**
 * Source for a reviver that runs inside the realm that evaluates it. It returns a function
 * from encoded JSON text to a value built from that realm's own intrinsics.
 */
export const snapshotReviverSource = `(function () {
  var TAG = ${TAG_LITERAL};
  // defineProperty, not assignment: an own "__proto__" key stays a key.
  var put = function (target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
  };
  var revive = function (value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(revive);
    if (typeof value[TAG] !== "string") {
      var out = {};
      for (var key in value) put(out, key, revive(value[key]));
      return out;
    }
    var kind = value[TAG];
    var inner = value.value;
    switch (kind) {
      case "undefined": return undefined;
      case "number": return Number(inner);
      case "bigint": return BigInt(inner);
      case "date": return new Date(inner);
      case "regexp": return new RegExp(inner[0], inner[1]);
      case "error": { var error = new Error(inner.message); error.name = inner.name; error.stack = inner.stack; return error; }
      case "map": return new Map(inner.map(function (pair) { return [revive(pair[0]), revive(pair[1])]; }));
      case "set": return new Set(inner.map(revive));
      case "object": { var plain = {}; for (var name in inner) put(plain, name, revive(inner[name])); return plain; }
      default: {
        var Ctor = globalThis[kind];
        if (kind === "BigInt64Array" || kind === "BigUint64Array") return Ctor.from(inner.map(BigInt));
        return Ctor.from(inner);
      }
    }
  };
  return function (text) { return revive(JSON.parse(text)); };
})()`

// ── frames ──────────────────────────────────────────────────────────────────

export const maximumCellSourceLength = 256 * 1024
export const maximumCellDisplayLength = 64 * 1024
export const maximumCellBindings = 1024
export const maximumCellFrameBytes = 1024 * 1024
export const maximumCellDisplayHeadLength = 48 * 1024
export const maximumPendingCellCalls = 32
export const maximumCallsPerCell = 4096
const maximumCatalogEntries = 512

/** A tool id segment that needs no brackets in a property path. */
const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const encodeSegment = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/**
 * Keys JavaScript reads on its own or already defines on a function: `await`
 * reads `then`, `JSON.stringify` reads `toJSON`, coercion reads `toString`.
 * On a `tools` node these keep their JavaScript meaning and never name a tool,
 * so an id with such a segment is reached through `tools(id)` instead.
 */
export const reservedToolSegments: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype),
  "prototype",
  "then",
  "toJSON",
  "inspect",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
])

/**
 * The source a model writes to reach `id`: `tools.delegate.start`,
 * `tools["must-not-run"]`, or `tools("read.then")` when a segment is reserved.
 */
export const toolPath = (id: string): string => {
  const segments = id.split(".")
  if (segments.some((segment) => reservedToolSegments.has(segment))) {
    return `tools(${encodeSegment(id)})`
  }
  return segments
    .map((segment) => {
      if (identifierSegment.test(segment)) return `.${segment}`
      return `[${encodeSegment(segment)}]`
    })
    .reduce((path, segment) => `${path}${segment}`, "tools")
}

/** One selected host tool as the kernel describes it. Descriptions never grant execution. */
export const CellCatalogEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  guidelines: Schema.Array(Schema.String),
  parameters: Schema.Json,
})
export type CellCatalogEntry = typeof CellCatalogEntry.Type

/** The kernel keeps the last catalog it received; the host resends only when the hash changes. */
export const CellCatalog = Schema.Struct({
  hash: Schema.String,
  tools: Schema.Array(CellCatalogEntry).check(Schema.isMaxLength(maximumCatalogEntries)),
})
export type CellCatalog = typeof CellCatalog.Type

export class CellEvaluationError extends Schema.TaggedError<CellEvaluationError>()(
  "CellEvaluationError",
  {
    phase: Schema.Literals(["source", "compile", "execute"]),
    message: Schema.String,
    output: Schema.String,
  },
) {}

/**
 * Restored names and named omissions from the last host-owned snapshot.
 * `previousSession` is present when the snapshot came from the previous
 * session of the thread, as after a handoff; absent, it is this branch's own.
 */
export const CellRestoreReport = Schema.Struct({
  restored: Schema.Array(Schema.String),
  omitted: Schema.Array(SnapshotOmission),
  previousSession: Schema.optional(Schema.String),
})
export type CellRestoreReport = typeof CellRestoreReport.Type

export const CellEvaluation = Schema.Struct({
  display: Schema.String,
  /**
   * The bindings the cell added or bound to another value. A result stored
   * before `bindingCount` existed lists every binding.
   */
  bindings: Schema.Array(Schema.String),
  /** How many bindings the namespace holds after the cell; absent on older results. */
  bindingCount: Schema.optional(Schema.Natural),
  truncated: Schema.Boolean,
  /** Present on the first evaluation after a worker was restored from a snapshot. */
  restored: Schema.optional(CellRestoreReport),
})
export type CellEvaluation = typeof CellEvaluation.Type

const CorrelationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const CellRequest = Schema.TaggedUnion({
  Evaluate: {
    cellId: CorrelationId,
    /** Unpredictable per-evaluation token the worker echoes in its output boundary. */
    outputToken: CorrelationId,
    source: Schema.String.check(Schema.isMaxLength(maximumCellSourceLength)),
    /** Present only when the host catalog changed since the worker last received one. */
    catalog: Schema.optional(CellCatalog),
  },
  Reset: { requestId: CorrelationId },
  Snapshot: { requestId: CorrelationId },
  Restore: { requestId: CorrelationId, bindings: Schema.Array(SnapshotBinding) },
  HostSucceeded: { cellId: CorrelationId, operationId: CorrelationId, value: Schema.Json },
  HostFailed: { cellId: CorrelationId, operationId: CorrelationId, message: Schema.String },
})
export type CellRequest = typeof CellRequest.Type

export const CellResponse = Schema.TaggedUnion({
  Ready: { version: Schema.Literal(1) },
  Evaluated: { cellId: CorrelationId, result: CellEvaluation },
  Failed: { cellId: CorrelationId, error: CellEvaluationError },
  Reset: {
    requestId: CorrelationId,
    /** Globals the worker could not put back; the host replaces a worker that names any. */
    unrestored: Schema.optional(Schema.Array(Schema.String)),
  },
  Snapshot: { requestId: CorrelationId, snapshot: CellSnapshot },
  Restored: { requestId: CorrelationId, bindings: Schema.Array(Schema.String) },
  HostCall: {
    cellId: CorrelationId,
    operationId: CorrelationId,
    name: Schema.String,
    input: Schema.Json,
  },
})
export type CellResponse = typeof CellResponse.Type

export class CellProtocolError extends Schema.TaggedError<CellProtocolError>()(
  "CellProtocolError",
  { message: Schema.String },
) {}

const protocolError = (cause: unknown) => new CellProtocolError({ message: String(cause) })
const requestCodec = Schema.fromJsonString(CellRequest)
const responseCodec = Schema.fromJsonString(CellResponse)

export const decodeCellRequest = (frame: string) =>
  Schema.decodeEffect(requestCodec)(frame).pipe(Effect.mapError(protocolError))
export const decodeCellResponse = (frame: string) =>
  Schema.decodeEffect(responseCodec)(frame).pipe(Effect.mapError(protocolError))

const frameBytes = (text: string): Effect.Effect<Uint8Array, CellProtocolError> => {
  const bytes = new TextEncoder().encode(text + "\n")
  if (bytes.byteLength - 1 > maximumCellFrameBytes) {
    return Effect.fail(new CellProtocolError({ message: "Cell frame exceeds the byte limit" }))
  }
  return Effect.succeed(bytes)
}

export const encodeCellRequest = (request: CellRequest) =>
  Schema.encodeEffect(requestCodec)(request).pipe(
    Effect.mapError(protocolError),
    Effect.flatMap(frameBytes),
  )
export const encodeCellResponse = (response: CellResponse) =>
  Schema.encodeEffect(responseCodec)(response).pipe(
    Effect.mapError(protocolError),
    Effect.flatMap(frameBytes),
  )

/** A separate reader belongs to each pipe. It bounds incomplete lines before JSON decoding. */
export const makeCellFrameReader = () => {
  const buffer = new Uint8Array(maximumCellFrameBytes)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let length = 0
  return {
    push: (chunk: Uint8Array): Effect.Effect<ReadonlyArray<string>, CellProtocolError> =>
      Effect.gen(function* () {
        const frames: string[] = []
        for (const byte of chunk) {
          if (byte === 10) {
            if (length > 0) {
              const frame = yield* Effect.try({
                try: () => decoder.decode(buffer.subarray(0, length)),
                catch: protocolError,
              })
              frames.push(frame)
            }
            length = 0
          } else {
            if (length === maximumCellFrameBytes) {
              return yield* new CellProtocolError({ message: "Cell frame exceeds the byte limit" })
            }
            buffer[length++] = byte
          }
        }
        return frames
      }),
    end: Effect.suspend(() => {
      if (length === 0) return Effect.void
      return Effect.fail(new CellProtocolError({ message: "Cell pipe closed during a frame" }))
    }),
  }
}

const boundaryDelimiter = "\u001e"
const boundaryPrefix = "gent-cell-end "
const maximumBoundaryTokenLength = 128
const maximumBoundaryLength =
  boundaryDelimiter.length * 2 + boundaryPrefix.length + maximumBoundaryTokenLength

/** The worker writes this to its output pipe after a cell, before its result frame. */
export const cellOutputBoundary = (token: string) =>
  `${boundaryDelimiter}${boundaryPrefix}${token}${boundaryDelimiter}`

/** Cell text in arrival order; a boundary closes the text that came before it. */
export interface CellOutputSegment {
  readonly text: string
  readonly boundary: Option.Option<string>
}

/**
 * Splits one output stream into text and boundaries, whatever the chunk splits are.
 * Only a well-formed boundary carrying the expected token counts; anything else,
 * including a boundary for another token, stays text.
 */
export const makeCellOutputScanner = (expected: () => Option.Option<string>) => {
  let pending = ""
  return {
    push: (chunk: string): ReadonlyArray<CellOutputSegment> => {
      let input = pending + chunk
      pending = ""
      const segments: CellOutputSegment[] = []
      let text = ""
      while (input.length > 0) {
        const start = input.indexOf(boundaryDelimiter)
        if (start === -1) {
          text += input
          break
        }
        text += input.slice(0, start)
        const end = input.indexOf(boundaryDelimiter, start + 1)
        if (end === -1) {
          if (input.length - start > maximumBoundaryLength) {
            text += boundaryDelimiter
            input = input.slice(start + 1)
            continue
          }
          pending = input.slice(start)
          break
        }
        const candidate = input.slice(start + 1, end)
        const token = candidate.slice(boundaryPrefix.length)
        const wellFormed =
          candidate.startsWith(boundaryPrefix) &&
          token.length > 0 &&
          token.length <= maximumBoundaryTokenLength
        if (wellFormed && Option.contains(expected(), token)) {
          segments.push({ text, boundary: Option.some(token) })
          text = ""
          input = input.slice(end + 1)
        } else {
          text += input.slice(start, end)
          input = input.slice(end)
        }
      }
      if (text.length > 0) segments.push({ text, boundary: Option.none() })
      return segments
    },
    /** Text held back as a possible boundary when the stream closes. */
    end: (): string => {
      const rest = pending
      pending = ""
      return rest
    },
  }
}

/** A bounded accumulator of output text: a head, an omitted count, and a bounded tail. */
interface BoundedOutput {
  /** Add text; anything past the head spills into the bounded tail. */
  readonly append: (text: string) => void
  /** The accumulated text, with an omission notice when anything was dropped. */
  readonly read: () => string
  /** `read()`, then reset to empty. */
  readonly take: () => string
  /** Whether any text has been dropped. */
  readonly truncated: () => boolean
  /** Reset to empty without reading. */
  readonly reset: () => void
}

/**
 * Keeps the first `headLimit` characters and the last `limit - headLimit`, so the
 * end of a long output — usually the error — survives alongside its beginning.
 * `separator` goes between appends once anything has been written.
 */
export const makeBoundedOutput = (options: {
  readonly limit: number
  readonly headLimit: number
  readonly separator?: string
}): BoundedOutput => {
  const separator = options.separator ?? ""
  const tailLimit = Math.max(0, options.limit - options.headLimit)
  let head = ""
  let tail = ""
  let omitted = 0
  // Text that spilled past the head but still fits is whole: no notice until
  // a character is really dropped.
  const read = (): string => {
    if (omitted === 0) return head + tail
    return `${head}\n... [${omitted} characters omitted] ...\n${tail}`
  }
  const reset = (): void => {
    head = ""
    tail = ""
    omitted = 0
  }
  return {
    append: (text: string): void => {
      let lead = ""
      if (head.length > 0 || tail.length > 0) lead = separator
      const next = lead + text
      const headRoom = Math.max(0, options.headLimit - head.length)
      if (headRoom >= next.length) {
        head += next
        return
      }
      head += next.slice(0, headRoom)
      tail += next.slice(headRoom)
      if (tail.length > tailLimit) {
        omitted += tail.length - tailLimit
        tail = tail.slice(tail.length - tailLimit)
      }
    },
    read,
    take: (): string => {
      const result = read()
      reset()
      return result
    },
    truncated: () => omitted > 0,
    reset,
  }
}

// ── descriptors ─────────────────────────────────────────────────────────────

/** Worker-to-host frames travel on this descriptor; the worker owns stdout for cell output. */
export const cellResponseFd = 3
/** Host-to-worker frames travel on this descriptor. */
export const cellRequestFd = 4
