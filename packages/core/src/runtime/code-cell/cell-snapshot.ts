/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noUnknownParameters, effect/noObjectParameters -- This codec is the realm boundary for namespace values; it must inspect arbitrary JavaScript objects and encode JSON null/undefined by design. */
import { Predicate, Schema } from "effect"

/**
 * Namespace snapshots move cell bindings between a worker and the host as
 * tagged JSON. The worker encodes in its own realm with realm-agnostic checks;
 * the vm context decodes with a reviver that runs inside the context, so
 * restored dates, maps, sets, and errors carry the context's own intrinsics.
 */
export const maximumSnapshotBindingBytes = 256 * 1024
export const maximumSnapshotBytes = 768 * 1024
const maximumSnapshotDepth = 64

export const SnapshotOmission = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literals(["function", "unsupported", "cyclic", "too-deep", "too-large"]),
})
export type SnapshotOmission = typeof SnapshotOmission.Type
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

const tagged = (kind: string, value: Schema.Json): Schema.Json => ({ [TAG]: kind, value })
/** Effect's isObject excludes arrays; snapshots treat both as references. */
const isReference = (value: unknown): value is object =>
  Predicate.isObject(value) || Array.isArray(value)
const tagOf = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1)

/** Plain means its prototype is null or a root Object.prototype from any realm. */
const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || Object.getPrototypeOf(proto) === null
}

interface ElementView extends ArrayBufferView {
  readonly length: number
  readonly [index: number]: number | bigint
}
const isElementView = (view: ArrayBufferView): view is ElementView =>
  Predicate.hasProperty(view, "length") && Predicate.isNumber(view.length)

/** Typed arrays travel as element lists; bigint elements travel as strings. */
const elements = (view: ElementView): Schema.Json => {
  const values: Schema.Json[] = []
  for (let index = 0; index < view.length; index++) {
    const item = view[index]
    if (Predicate.isBigInt(item)) values.push(item.toString())
    else if (Predicate.isNumber(item)) values.push(item)
  }
  return values
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

const encodePrimitive = (value: unknown): Encoded | undefined => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value
  if (Predicate.isUndefined(value)) return tagged("undefined", null)
  if (Predicate.isNumber(value)) {
    if (Number.isFinite(value)) return value
    return tagged("number", String(value))
  }
  if (Predicate.isBigInt(value)) return tagged("bigint", value.toString())
  if (Predicate.isFunction(value)) return new Omitted("function")
  if (!isReference(value)) return new Omitted("unsupported")
  return undefined
}

const encodeList = (items: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  const out: Schema.Json[] = []
  for (const item of items) {
    const encoded = inner(item)
    if (isOmitted(encoded)) return encoded
    out.push(encoded)
  }
  return out
}

const encodeRecord = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  inner: (item: unknown) => Encoded,
): Encoded => {
  const out: Record<string, Schema.Json> = {}
  for (const [key, item] of entries) {
    const encoded = inner(item)
    if (isOmitted(encoded)) return encoded
    out[key] = encoded
  }
  if (Predicate.hasProperty(out, TAG)) return tagged("object", out)
  return out
}

const encodeBuiltin = (value: object, inner: (item: unknown) => Encoded): Encoded | undefined => {
  const kind = tagOf(value)
  if (kind === "Date") return tagged("date", Date.prototype.getTime.call(value))
  if (
    kind === "RegExp" &&
    Predicate.hasProperty(value, "source") &&
    Predicate.hasProperty(value, "flags")
  )
    return tagged("regexp", [String(value.source), String(value.flags)])
  if (kind === "Error" && Predicate.hasProperty(value, "message")) {
    let name = "Error"
    if (Predicate.hasProperty(value, "name")) name = String(value.name)
    let stack = ""
    if (Predicate.hasProperty(value, "stack")) stack = String(value.stack)
    return tagged("error", { name, message: String(value.message), stack })
  }
  if (kind === "Map") {
    const entries: Iterable<[unknown, unknown]> = Map.prototype.entries.call(value)
    const pairs = encodeList([...entries], (pair) => {
      if (!Array.isArray(pair)) return new Omitted("unsupported")
      return encodeList(pair, inner)
    })
    if (isOmitted(pairs)) return pairs
    return tagged("map", pairs)
  }
  if (kind === "Set") {
    const values: Iterable<unknown> = Set.prototype.values.call(value)
    const list = encodeList([...values], inner)
    if (isOmitted(list)) return list
    return tagged("set", list)
  }
  if (ArrayBuffer.isView(value)) {
    if (!typedArrayKinds.has(kind) || !isElementView(value)) return new Omitted("unsupported")
    return tagged(kind, elements(value))
  }
  return undefined
}

const encodeValue = (value: unknown, depth: number, seen: Set<object>): Encoded => {
  if (depth > maximumSnapshotDepth) return new Omitted("too-deep")
  const primitive = encodePrimitive(value)
  if (!Predicate.isUndefined(primitive)) return primitive
  if (!isReference(value)) return new Omitted("unsupported")
  const object: object = value
  if (seen.has(object)) return new Omitted("cyclic")
  seen.add(object)
  const inner = (child: unknown) => encodeValue(child, depth + 1, seen)
  let encoded: Encoded
  const builtin = encodeBuiltin(object, inner)
  if (!Predicate.isUndefined(builtin)) encoded = builtin
  else if (Array.isArray(object)) encoded = encodeList(object, inner)
  else if (isPlainObject(object)) encoded = encodeRecord(Object.entries(object), inner)
  else encoded = new Omitted("unsupported")
  seen.delete(object)
  return encoded
}

const jsonBytes = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Encode every binding. Values that cannot round-trip are named with the reason, never silently dropped. */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>): CellSnapshot => {
  const bindings: SnapshotBinding[] = []
  const omitted: SnapshotOmission[] = []
  let total = 0
  for (const [name, value] of namespace) {
    const encoded = encodeValue(value, 0, new Set())
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

/**
 * Source for a reviver that runs inside the vm context. It returns a function
 * from encoded JSON text to a value built from the context's own intrinsics.
 */
export const snapshotReviverSource = `(function () {
  var TAG = ${JSON.stringify(TAG)};
  var revive = function (value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(revive);
    if (typeof value[TAG] !== "string") {
      var out = {};
      for (var key in value) out[key] = revive(value[key]);
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
      case "object": { var plain = {}; for (var name in inner) plain[name] = revive(inner[name]); return plain; }
      default: {
        var Ctor = globalThis[kind];
        if (kind === "BigInt64Array" || kind === "BigUint64Array") return Ctor.from(inner.map(BigInt));
        return Ctor.from(inner);
      }
    }
  };
  return function (text) { return revive(JSON.parse(text)); };
})()`
