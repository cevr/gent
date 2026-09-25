import { Option, Predicate, Result, Schema } from "effect"
import { types } from "node:util"
import {
  type CellSnapshot,
  type SnapshotBinding,
  type SnapshotOmission,
  snapshotTag,
} from "./cell-protocol.js"

/**
 * A cell runs in full Bun, in the same realm as the worker that reads its
 * values. A getter, a Proxy trap, a `toString`, a `Symbol.toPrimitive`, an
 * iterator or any prototype method the cell wrote or replaced is cell code,
 * and cell code may loop or throw. This module reads and displays a cell value
 * without running any of it. The snapshot codec, the error renderer and the
 * worker's display read through it.
 *
 * - It reads properties through their descriptors: a data value, or a host
 *   getter from `hostGetters`, compared by identity.
 * - It never touches a Proxy. Bun's `util.types.isProxy` reads the engine's
 *   own proxy mark; no trap runs, so no Proxy can fake the answer.
 * - It checks a built-in's brand with `util.types`, which reads the internal
 *   slot.
 * - Every function it calls is saved when the module loads, before any cell
 *   runs, and is called with the saved `Reflect.apply`. It never calls a method
 *   through a value or through a prototype at call time: no `value.toString()`,
 *   no iterator, no spread, no `push`, no string or array prototype method.
 *   Lists grow through the saved `Reflect.defineProperty`, with a descriptor
 *   that has no prototype, so no setter or inherited descriptor field on
 *   `Array.prototype` or `Object.prototype` runs.
 *
 * Out of reach: the Effect data this module returns (`Option`, `Result`) is
 * built by Effect, which assigns fields; the worker's Effect runtime and its
 * JSON frames do the same on every step. A cell that plants a setter on
 * `Object.prototype` stalls the whole worker, and the host replaces a worker
 * that stops answering.
 */

// ── saved intrinsics ────────────────────────────────────────────────────────

const isProxy = types.isProxy
const isNativeError = types.isNativeError
const isRegExp = types.isRegExp
const isDate = types.isDate
const isMap = types.isMap
const isSet = types.isSet
const isTypedArray = types.isTypedArray
const isPromise = types.isPromise
const isWeakMap = types.isWeakMap
const isWeakSet = types.isWeakSet
const isAnyArrayBuffer = types.isAnyArrayBuffer
const isBoxedPrimitive = types.isBoxedPrimitive
const isNumberObject = types.isNumberObject
const isStringObject = types.isStringObject
const isBooleanObject = types.isBooleanObject
const isBigIntObject = types.isBigIntObject
const isAsyncFunction = types.isAsyncFunction
const isGeneratorFunction = types.isGeneratorFunction
const isArgumentsObject = types.isArgumentsObject
const ownDescriptor = Object.getOwnPropertyDescriptor
const prototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys
const hasOwn = Object.hasOwn
const apply = Reflect.apply
const construct = Reflect.construct
const defineOwn = Reflect.defineProperty
const setPrototype = Reflect.setPrototypeOf
const isArray = Array.isArray
/** The abstract ToString for a primitive: it reads no prototype. Never called with an object. */
const toText = String
const isFiniteNumber = Number.isFinite
const isNotANumber = Number.isNaN
const sameValue = Object.is
const readField = Reflect.get
const stringifyJson = JSON.stringify
const squareRoot = Math.sqrt
const roundNumber = Math.round
const floorNumber = Math.floor
const smallest = Math.min
const largest = Math.max
const ByteView = Uint8Array
const errorPrototype: object = Error.prototype

/** The getter a descriptor holds; none for a data property. */
const descriptorGetter = (descriptor: PropertyDescriptor) =>
  Option.liftPredicate(readField(descriptor, "get"), Predicate.isFunction)

/** An intrinsic accessor's getter, taken now. */
const intrinsicGetter = (prototype: object, key: PropertyKey) =>
  Option.flatMap(Option.fromUndefinedOr(ownDescriptor(prototype, key)), descriptorGetter)

/** An intrinsic method, taken now. */
const intrinsicMethod = (prototype: object, key: PropertyKey) =>
  Option.flatMap(Option.fromUndefinedOr(ownDescriptor(prototype, key)), (descriptor) =>
    Option.liftPredicate(Reflect.get(descriptor, "value"), Predicate.isFunction),
  )

/** An intrinsic every Bun has; a missing one fails the module load, before any cell runs. */
const requiredMethod = (prototype: object, key: PropertyKey): Function =>
  Option.getOrThrow(intrinsicMethod(prototype, key))
const requiredGetter = (prototype: object, key: PropertyKey): Function =>
  Option.getOrThrow(intrinsicGetter(prototype, key))

const typedArrayPrototype: object = prototypeOf(Uint8Array.prototype)
const charCodeAt = requiredMethod(String.prototype, "charCodeAt")
const stringSlice = requiredMethod(String.prototype, "slice")
const functionSource = requiredMethod(Function.prototype, "toString")
const dateTime = requiredMethod(Date.prototype, "getTime")
const dateIso = requiredMethod(Date.prototype, "toISOString")
const mapForEach = requiredMethod(Map.prototype, "forEach")
const setForEach = requiredMethod(Set.prototype, "forEach")
const mapSize = requiredGetter(Map.prototype, "size")
const setSize = requiredGetter(Set.prototype, "size")
const typedArrayKind = requiredGetter(typedArrayPrototype, Symbol.toStringTag)
const typedArrayLength = requiredGetter(typedArrayPrototype, "length")
const regExpSource = requiredGetter(RegExp.prototype, "source")
const numberValue = requiredMethod(Number.prototype, "valueOf")
const stringValue = requiredMethod(String.prototype, "valueOf")
const booleanValue = requiredMethod(Boolean.prototype, "valueOf")
const bigIntValue = requiredMethod(BigInt.prototype, "valueOf")
const symbolValue = requiredMethod(Symbol.prototype, "valueOf")
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
const regExpFlags: ReadonlyArray<{ readonly flag: string; readonly get: Function }> =
  regExpFlagKeys.flatMap(([flag, key]) =>
    Option.toArray(Option.map(intrinsicGetter(RegExp.prototype, key), (get) => ({ flag, get }))),
  )

/**
 * The host getters a property read runs: those on the prototype of every
 * error type the realm defines as a global, `Error` included. Bun keeps a
 * `DOMException`'s name and message, and a `BuildMessage`'s position, behind
 * such getters. Taken when the module loads, before any cell runs, from data
 * globals only. A closed list compared by identity: a cell's own getter, a
 * bound one that prints as native code included, is never in it.
 */
const hostGetters: ReadonlyArray<unknown> = Object.getOwnPropertyNames(globalThis)
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
  )

// ── list and text helpers ───────────────────────────────────────────────────

/** A saved intrinsic called on a value. */
const call = (fn: Function, target: unknown, args: ReadonlyArray<unknown> = []): unknown =>
  apply(fn, target, args)

/** A data slot with no prototype: defining it reads no inherited descriptor field. */
const dataSlot = (value: unknown): PropertyDescriptor => {
  const slot = { value, writable: true, enumerable: true, configurable: true }
  setPrototype(slot, null)
  return slot
}

/** Define an own data property; no setter along the prototype chain runs. */
const defineData = (target: object, key: PropertyKey, value: unknown): void => {
  defineOwn(target, key, dataSlot(value))
}

/** Add to the end of a list the caller owns, without `push`. */
const append = <A>(list: Array<A>, value: A): void => defineData(list, list.length, value)

/** An item of a dense list the caller owns; the fallback past its end, never a read through its prototype. */
const itemAt = <A>(list: ReadonlyArray<A>, index: number, fallback: A): A => {
  if (index < 0 || index >= list.length) return fallback
  const item = list[index]
  if (item === undefined) return fallback
  return item
}

/** Remove the last item of a list the caller owns. */
const dropLast = (list: Array<unknown>): void => {
  if (list.length > 0) list.length = list.length - 1
}

/** Whether a list the caller owns holds this exact value. */
const holds = (list: ReadonlyArray<unknown>, value: unknown): boolean => {
  for (let index = 0; index < list.length; index++) if (list[index] === value) return true
  return false
}

/** Where a list the caller owns holds this exact value; -1 when it does not. */
const positionOf = (list: ReadonlyArray<unknown>, value: unknown): number => {
  for (let index = 0; index < list.length; index++) if (list[index] === value) return index
  return -1
}

const codeAt = (text: string, index: number): number => {
  const code = call(charCodeAt, text, [index])
  if (Predicate.isNumber(code)) return code
  return -1
}

const slice = (text: string, start: number, end: number): string => {
  const part = call(stringSlice, text, [start, end])
  if (Predicate.isString(part)) return part
  return ""
}

const holdsCode = (text: string, code: number): boolean => {
  for (let index = 0; index < text.length; index++) if (codeAt(text, index) === code) return true
  return false
}

/** Whether a text holds `${`, which a template literal would read as a placeholder. */
const holdsPlaceholder = (text: string): boolean => {
  for (let index = 0; index + 1 < text.length; index++)
    if (codeAt(text, index) === 36 && codeAt(text, index + 1) === 123) return true
  return false
}

const spaces = (count: number): string => {
  let out = ""
  for (let index = 0; index < count; index++) out += " "
  return out
}

const join = (list: ReadonlyArray<string>, separator: string): string => {
  let out = ""
  for (let index = 0; index < list.length; index++) {
    if (index > 0) out += separator
    out += list[index]
  }
  return out
}

const padStart = (text: string, width: number): string => spaces(width - text.length) + text
const padEnd = (text: string, width: number): string => text + spaces(width - text.length)

const plural = (count: number, one: string, many: string): string => {
  if (count > 1) return many
  return one
}

const hexDigits = "0123456789abcdef"
const upperHexDigits = "0123456789ABCDEF"

/** A code unit as hexadecimal of at least `width` digits. */
const hex = (value: number, width: number, digits: string): string => {
  let out = ""
  let rest = value
  while (rest > 0 || out.length < width) {
    out = digits[rest % 16] + out
    rest = floorNumber(rest / 16)
  }
  return out
}

// ── value reader ────────────────────────────────────────────────────────────

/** Prototype links a read follows before it gives up. */
const PROTOTYPE_DEPTH_LIMIT = 32

/** A read that would run cell code: a Proxy on the path, or a getter the cell wrote. */
class UnreadableValue extends Schema.TaggedError<UnreadableValue>()("UnreadableValue", {}) {}
/** A read the reader made, or `UnreadableValue` where making it would run cell code. */
type ValueRead<A> = Result.Result<A, UnreadableValue>
const unreadable: ValueRead<never> = Result.fail(new UnreadableValue())

/** A property found along the prototype chain, running only the getters in `getters`. */
const readThrough =
  (getters: ReadonlyArray<unknown>) =>
  (target: object, key: PropertyKey): ValueRead<Option.Option<unknown>> => {
    let holder: unknown = target
    for (let depth = 0; depth < PROTOTYPE_DEPTH_LIMIT; depth++) {
      if (!Predicate.isObjectKeyword(holder)) return Result.succeed(Option.none())
      if (isProxy(holder)) return unreadable
      const descriptor = ownDescriptor(holder, key)
      if (Predicate.isNotUndefined(descriptor)) {
        if (hasOwn(descriptor, "value")) return Result.succeed(Option.some(descriptor.value))
        const get = descriptorGetter(descriptor)
        if (Option.isSome(get) && holds(getters, get.value))
          return Result.succeed(Option.some(call(get.value, target)))
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
export const readDataProperty = readThrough([])

/** A data property's value, none when absent, an accessor, or behind a Proxy. */
const dataValue = (target: object, key: PropertyKey): Option.Option<unknown> =>
  Result.getOrElse(readDataProperty(target, key), () => Option.none())

/** Whether `prototype` is on a value's prototype chain, as `instanceof` asks, with no trap run. */
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
export const isOrdinaryArray = (value: unknown): value is ReadonlyArray<unknown> =>
  !isProxy(value) && isArray(value)

/** An own field of a descriptor; an absent one reads as undefined, never through `Object.prototype`. */
const descriptorField = (descriptor: PropertyDescriptor, key: string): unknown => {
  if (hasOwn(descriptor, key)) return readField(descriptor, key)
  return undefined
}

/** Whether two descriptors hold the same value or accessors and the same flags. */
export const sameDescriptor = (left: PropertyDescriptor, right: PropertyDescriptor): boolean => {
  const fields = ["value", "get", "set", "writable", "enumerable", "configurable"]
  for (let index = 0; index < fields.length; index++) {
    const field = itemAt(fields, index, "value")
    if (!sameValue(descriptorField(left, field), descriptorField(right, field))) return false
  }
  return true
}

/** A date's time value through the saved `getTime`, which reads the internal slot. */
const readDate = (value: object): Option.Option<number> => {
  if (!isDate(value)) return Option.none()
  return Option.liftPredicate(call(dateTime, value), Predicate.isNumber)
}

/** A regular expression's source and flags through the saved slot getters. */
const readRegExp = (
  value: object,
): Option.Option<{ readonly source: string; readonly flags: string }> => {
  if (!isRegExp(value)) return Option.none()
  const source = call(regExpSource, value)
  if (!Predicate.isString(source)) return Option.none()
  let flags = ""
  for (let index = 0; index < regExpFlags.length; index++) {
    const found = regExpFlags[index]
    if (found === undefined) continue
    const { flag, get } = found
    if (call(get, value) === true) flags += flag
  }
  return Option.some({ source, flags })
}

/** A Map or Set member: its value and, for a Map, its key. */
interface CollectionMember {
  readonly value: unknown
  readonly key: unknown
}

/**
 * A Map's or Set's size and first `limit` members through the saved `size`
 * getter and `forEach`, which walk the internal table, so a subclass
 * iterator never runs.
 */
const readCollection = (
  value: object,
  limit: number,
): Option.Option<{ readonly size: number; readonly members: ReadonlyArray<CollectionMember> }> => {
  let size: unknown
  let forEach: Function
  if (isMap(value)) {
    size = call(mapSize, value)
    forEach = mapForEach
  } else if (isSet(value)) {
    size = call(setSize, value)
    forEach = setForEach
  } else return Option.none()
  if (!Predicate.isNumber(size)) return Option.none()
  const members: Array<CollectionMember> = []
  call(forEach, value, [
    (item: unknown, key: unknown) => {
      if (members.length < limit) append(members, { value: item, key })
    },
  ])
  return Option.some({ size, members })
}

/** A typed array's kind and length through the saved slot getters. */
const readTypedArray = (
  value: object,
): Option.Option<{ readonly kind: string; readonly length: number }> => {
  if (!isTypedArray(value)) return Option.none()
  const kind = call(typedArrayKind, value)
  const length = call(typedArrayLength, value)
  if (!Predicate.isString(kind) || !Predicate.isNumber(length)) return Option.none()
  return Option.some({ kind, length })
}

/** An element of a typed array: an integer index reads its buffer, never its prototype. */
const typedArrayItem = (value: object, index: number): unknown =>
  Option.getOrUndefined(
    Option.map(Option.fromUndefinedOr(ownDescriptor(value, index)), (d) => d.value),
  )

/** `name: message`, each read only when its value is a string; a host getter can throw. */
export const errorHead = (error: object): string => {
  const name = Option.getOrElse(
    Option.filter(
      Result.getOrElse(readProperty(error, "name"), () => Option.none()),
      Predicate.isString,
    ),
    () => "Error",
  )
  return Option.match(
    Option.filter(
      Result.getOrElse(readProperty(error, "message"), () => Option.none()),
      Predicate.isString,
    ),
    {
      onNone: () => name,
      onSome: (message) => `${name}: ${message}`,
    },
  )
}

// ── namespace snapshot codec ────────────────────────────────────────────────

/**
 * The worker encodes cell bindings to tagged JSON through the value reader,
 * so encoding runs no getter, trap or iterator. Brand checks read internal
 * slots, so they hold for a value from any realm. The reviver in
 * `cell-protocol.ts` decodes it in the realm that restores.
 */
export const maximumSnapshotBindingBytes = 256 * 1024
const maximumSnapshotBytes = 768 * 1024
const maximumSnapshotDepth = 64
/** Each entry encodes to at least two bytes, so a longer collection is too large unread. */
const maximumSnapshotEntries = maximumSnapshotBindingBytes / 2

/** A value that cannot round-trip. It never enters the encoded JSON. Each is made at load. */
class Omitted {
  constructor(readonly reason: OmissionReason) {}
}
type OmissionReason = SnapshotOmission["reason"]
type Encoded = Schema.Json | Omitted
const isOmitted = (value: Encoded): value is Omitted => value instanceof Omitted
const omittedFunction = new Omitted("function")
const unsupported = new Omitted("unsupported")
const cyclic = new Omitted("cyclic")
const tooDeep = new Omitted("too-deep")
const tooLarge = new Omitted("too-large")

const tagged = (kind: string, value: Schema.Json): Schema.Json => ({ [snapshotTag]: kind, value })

/** Plain means its prototype is null or a root Object.prototype from any realm. */
const isPlainObject = (value: object) => {
  const proto: unknown = prototypeOf(value)
  if (proto === null) return true
  if (!Predicate.isObjectKeyword(proto) || isProxy(proto)) return false
  return prototypeOf(proto) === null
}

const typedArrayKinds: ReadonlyArray<string> = [
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
]

const encodePrimitive = (value: unknown): Encoded | undefined => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value
  if (Predicate.isUndefined(value)) return tagged("undefined", null)
  if (Predicate.isNumber(value)) {
    if (isFiniteNumber(value)) return value
    return tagged("number", toText(value))
  }
  // The abstract ToString: a replaced `BigInt.prototype.toString` never runs.
  if (Predicate.isBigInt(value)) return tagged("bigint", toText(value))
  if (Predicate.isFunction(value)) return omittedFunction
  if (!Predicate.isObjectKeyword(value)) return unsupported
  return undefined
}

/** An array's elements through their descriptors; a hole reads as undefined. */
const encodeArray = (array: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  // An array's own length is a data property: no getter can stand in for it.
  if (array.length > maximumSnapshotEntries) return tooLarge
  const out: Schema.Json[] = []
  for (let index = 0; index < array.length; index++) {
    const encoded = Result.match(readProperty(array, index), {
      onFailure: (): Encoded => unsupported,
      onSuccess: (item) => inner(Option.getOrUndefined(item)),
    })
    if (isOmitted(encoded)) return encoded
    append(out, encoded)
  }
  return out
}

/** A plain object's own enumerable string keys, in `Object.entries` order; any accessor is cell code. */
const encodeRecord = (object: object, inner: (item: unknown) => Encoded): Encoded => {
  const keys = ownKeys(object)
  if (keys.length > maximumSnapshotEntries) return tooLarge
  const out: Record<string, Schema.Json> = {}
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (!Predicate.isString(key)) continue
    const descriptor = ownDescriptor(object, key)
    if (Predicate.isUndefined(descriptor) || descriptor.enumerable !== true) continue
    if (!hasOwn(descriptor, "value")) return unsupported
    const encoded = inner(descriptor.value)
    if (isOmitted(encoded)) return encoded
    // Assignment to an own `__proto__` key would set the prototype and drop the key.
    defineData(out, key, encoded)
  }
  if (hasOwn(out, snapshotTag)) return tagged("object", out)
  return out
}

/** A native error's `name`, `message` or `stack`: a primitive as text, absent as the fallback. */
const errorText = (error: object, key: string, fallback: string): Option.Option<string> =>
  Result.match(readProperty(error, key), {
    onFailure: () => Option.none(),
    onSuccess: (found) => {
      if (Option.isNone(found)) return Option.some(fallback)
      // String() of an object runs its toString or Symbol.toPrimitive: cell code.
      const text = found.value
      if (Predicate.isObjectKeyword(text)) return Option.none()
      return Option.some(toText(text))
    },
  })

const encodeError = (error: object): Encoded => {
  const name = errorText(error, "name", "Error")
  const message = errorText(error, "message", "")
  const stack = errorText(error, "stack", "")
  if (Option.isNone(name) || Option.isNone(message) || Option.isNone(stack)) return unsupported
  return tagged("error", { name: name.value, message: message.value, stack: stack.value })
}

const encodeRegExp = (value: object): Encoded =>
  Option.match(readRegExp(value), {
    onNone: () => unsupported,
    onSome: ({ source, flags }) => tagged("regexp", [source, flags]),
  })

/** A Map's or Set's members through the saved `size` getter and `forEach`; a Map member encodes as `[key, value]`. */
const encodeCollection = (
  value: object,
  kind: "map" | "set",
  inner: (item: unknown) => Encoded,
): Encoded => {
  const collection = readCollection(value, maximumSnapshotEntries)
  if (Option.isNone(collection)) return unsupported
  if (collection.value.size > maximumSnapshotEntries) return tooLarge
  const members = collection.value.members
  const out: Schema.Json[] = []
  for (let index = 0; index < members.length; index++) {
    const member = members[index]
    if (Predicate.isUndefined(member)) return unsupported
    let key: Encoded = null
    if (kind === "map") {
      key = inner(member.key)
      if (isOmitted(key)) return key
    }
    const item = inner(member.value)
    if (isOmitted(item)) return item
    if (kind === "map") append(out, [key, item])
    else append(out, item)
  }
  return tagged(kind, out)
}

const encodeTypedArray = (value: object): Encoded => {
  const typed = readTypedArray(value)
  if (Option.isNone(typed) || !holds(typedArrayKinds, typed.value.kind)) return unsupported
  const { kind, length } = typed.value
  if (length > maximumSnapshotEntries) return tooLarge
  const values: Schema.Json[] = []
  for (let index = 0; index < length; index++) {
    const item = typedArrayItem(value, index)
    // Bigint elements travel as strings, through the abstract ToString.
    if (Predicate.isBigInt(item)) append(values, toText(item))
    else if (Predicate.isNumber(item)) append(values, item)
  }
  return tagged(kind, values)
}

/** Built-ins by brand: a brand check reads the internal slot, and the read uses a function saved at load. */
const encodeBuiltin = (value: object, inner: (item: unknown) => Encoded): Encoded | undefined => {
  if (isNativeError(value)) return encodeError(value)
  if (isDate(value))
    return Option.match(readDate(value), {
      onNone: () => unsupported,
      onSome: (time) => tagged("date", time),
    })
  if (isRegExp(value)) return encodeRegExp(value)
  if (isMap(value)) return encodeCollection(value, "map", inner)
  if (isSet(value)) return encodeCollection(value, "set", inner)
  if (isTypedArray(value)) return encodeTypedArray(value)
  return undefined
}

const encodeValue = (value: unknown, depth: number, seen: Array<object>): Encoded => {
  if (depth > maximumSnapshotDepth) return tooDeep
  const primitive = encodePrimitive(value)
  if (!Predicate.isUndefined(primitive)) return primitive
  // Every trap of a Proxy is cell code, and no read of one is safe.
  if (!Predicate.isObjectKeyword(value) || isProxy(value)) return unsupported
  const object: object = value
  if (holds(seen, object)) return cyclic
  append(seen, object)
  const inner = (child: unknown) => encodeValue(child, depth + 1, seen)
  let encoded: Encoded
  const builtin = encodeBuiltin(object, inner)
  if (!Predicate.isUndefined(builtin)) encoded = builtin
  else if (isOrdinaryArray(object)) encoded = encodeArray(object, inner)
  else if (isPlainObject(object)) encoded = encodeRecord(object, inner)
  else encoded = unsupported
  dropLast(seen)
  return encoded
}

/**
 * The JSON text's UTF-8 length. The frame encoder stringifies the same JSON a
 * moment later through the same intrinsics, so a hand-written serializer here
 * would guard nothing. Both functions are saved at load.
 */
const utf8Length = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = codeAt(text, index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // Stringified JSON escapes a lone surrogate, so a high one here opens a pair.
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

const jsonBytes = (value: Schema.Json): number => {
  const text: unknown = stringifyJson(value)
  if (Predicate.isString(text)) return utf8Length(text)
  return 0
}

/**
 * One binding's encoding. Encoding runs no cell code; a host getter can still
 * throw, and that value cannot round-trip either.
 */
const encodeBinding = Option.liftThrowable((value: unknown): Encoded => encodeValue(value, 0, []))

/** Encode every binding. Values that cannot round-trip are named with the reason, never silently dropped. */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>): CellSnapshot => {
  const bindings: Array<SnapshotBinding> = []
  const omitted: Array<SnapshotOmission> = []
  let total = 0
  // The saved `forEach` walks the namespace: a replaced Map iterator never runs.
  const entries = readCollection(namespace, Number.MAX_SAFE_INTEGER)
  const members = Option.match(entries, { onNone: () => [], onSome: (read) => read.members })
  for (let index = 0; index < members.length; index++) {
    const member = members[index]
    if (Predicate.isUndefined(member) || !Predicate.isString(member.key)) continue
    const name = member.key
    const encoded = Option.getOrElse(encodeBinding(member.value), () => unsupported)
    if (isOmitted(encoded)) {
      append(omitted, { name, reason: encoded.reason })
      continue
    }
    const size = jsonBytes(encoded)
    if (size > maximumSnapshotBindingBytes || total + size > maximumSnapshotBytes) {
      append(omitted, { name, reason: "too-large" })
      continue
    }
    total += size
    append(bindings, { name, value: encoded })
  }
  return { bindings, omitted }
}

// ── value display ───────────────────────────────────────────────────────────

/**
 * The display a model reads for a logged or returned value, a thrown
 * non-Error and a cause. It follows `util.inspect` with `depth: 4`,
 * `maxArrayLength: 100`, `maxStringLength: 8192` and no custom inspection,
 * line for line where it can, and reads only through the value reader:
 *
 * - A Proxy shows as `[Proxy]`; `inspect` shows its target.
 * - A value with a Proxy on its prototype chain shows its own properties
 *   under `[Object: unreadable prototype]`.
 * - An accessor shows as `[Getter]`, `[Setter]` or `[Getter/Setter]`, and a
 *   `Symbol.toStringTag` getter is never read.
 * - A nested error shows as `[Name: message]`, without its stack.
 * - An object lists at most 100 properties, and a display formats at most
 *   `displayBudget` values; the rest shows as `...`.
 */
export interface PromiseState {
  readonly status: "pending" | "fulfilled" | "rejected"
  readonly value: unknown
}

interface DisplayOptions {
  /** A promise's state, read by the host without running `then`; none when it cannot tell. */
  readonly promiseState: (promise: object) => Option.Option<PromiseState>
}

const displayDepth = 4
const displayListLength = 100
const displayStringLength = 8192
const displayBudget = 20_000
/** An array or typed array longer than this lists no extra keys: listing them reads every index key. */
const displayKeyScanLength = 10_000
/** Holes a sparse array steps over one at a time before it lists its keys. */
const holeScanLength = 10_000
const breakLength = 80
const compactLevels = 3
const minimumSplitLength = 16
const unreadableDisplay = "[unreadable]"

interface DisplayContext {
  readonly options: DisplayOptions
  indentation: number
  currentDepth: number
  budget: number
  readonly seen: Array<object>
  readonly circular: Array<object>
}

/** A prototype chain the reader cannot walk: a Proxy sits on it. */
const unreadablePrototype = Symbol("unreadable prototype")
/** A constructor's name; null for a null prototype. */
type ConstructorName = string | null | typeof unreadablePrototype

/** A layout: a base, braces, the listed items and the extra keys that follow them. */
interface Layout {
  readonly base: string
  readonly open: string
  readonly close: string
  readonly keys: ReadonlyArray<PropertyKey>
  /** An array-like list, which groups more than six items in columns. */
  readonly list: boolean
  readonly items: (context: DisplayContext, depth: number) => Array<string>
}

const noItems = (): Array<string> => []

// ── display: primitives and text ──

const formatNumber = (value: number): string => {
  if (value === 0 && 1 / value < 0) return "-0"
  return toText(value)
}

const escapeCode = (code: number): string => {
  switch (code) {
    case 8:
      return "\\b"
    case 9:
      return "\\t"
    case 10:
      return "\\n"
    case 12:
      return "\\f"
    case 13:
      return "\\r"
    case 39:
      return "\\'"
    case 92:
      return "\\\\"
    default:
      return `\\x${hex(code, 2, upperHexDigits)}`
  }
}

const isSurrogatePair = (text: string, index: number): boolean => {
  const code = codeAt(text, index)
  if (code < 0xd800 || code > 0xdbff || index + 1 >= text.length) return false
  const next = codeAt(text, index + 1)
  return next >= 0xdc00 && next <= 0xdfff
}

/** The quote `inspect` picks: single, else double, else a backtick. */
const quoteFor = (text: string): number => {
  if (!holdsCode(text, 39)) return 39
  if (!holdsCode(text, 34)) return 34
  if (!holdsCode(text, 96) && !holdsPlaceholder(text)) return 96
  return 39
}

const escapeText = (text: string, quote: number): string => {
  let out = ""
  let last = 0
  for (let index = 0; index < text.length; index++) {
    const code = codeAt(text, index)
    if (code === quote || code === 92 || code < 32 || (code > 126 && code < 160)) {
      out += slice(text, last, index) + escapeCode(code)
      last = index + 1
    } else if (code >= 0xd800 && code <= 0xdfff) {
      if (isSurrogatePair(text, index)) {
        index++
        continue
      }
      out += `${slice(text, last, index)}\\u${hex(code, 4, hexDigits)}`
      last = index + 1
    }
  }
  return out + slice(text, last, text.length)
}

const quoteMark = (quote: number): string => {
  if (quote === 34) return '"'
  if (quote === 96) return "`"
  return "'"
}

const quoteText = (text: string): string => {
  const quote = quoteFor(text)
  const mark = quoteMark(quote)
  return mark + escapeText(text, quote) + mark
}

/** Lines that each keep their trailing newline. */
const splitAfterNewlines = (text: string): Array<string> => {
  const lines: Array<string> = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (codeAt(text, index) !== 10) continue
    append(lines, slice(text, start, index + 1))
    start = index + 1
  }
  if (start < text.length) append(lines, slice(text, start, text.length))
  return lines
}

const formatString = (context: DisplayContext, value: string): string => {
  let text = value
  let trailer = ""
  if (text.length > displayStringLength) {
    const remaining = text.length - displayStringLength
    text = slice(text, 0, displayStringLength)
    trailer = `... ${remaining} more ${plural(remaining, "character", "characters")}`
  }
  if (text.length > minimumSplitLength && text.length > breakLength - context.indentation - 4) {
    const lines = splitAfterNewlines(text)
    const quoted: Array<string> = []
    for (let index = 0; index < lines.length; index++)
      append(quoted, quoteText(itemAt(lines, index, "")))
    return join(quoted, ` +\n${spaces(context.indentation + 2)}`) + trailer
  }
  return quoteText(text) + trailer
}

const formatPrimitive = (context: DisplayContext, value: unknown): string => {
  if (Predicate.isString(value)) return formatString(context, value)
  if (Predicate.isNumber(value)) return formatNumber(value)
  if (Predicate.isBigInt(value)) return `${toText(value)}n`
  if (Predicate.isSymbol(value) || Predicate.isBoolean(value)) return toText(value)
  if (value === null) return "null"
  return "undefined"
}

/** A key as `inspect` writes it: bare when an identifier, else quoted; a symbol as Bun writes it. */
const keyText = (key: PropertyKey): string => {
  if (Predicate.isSymbol(key)) return toText(key)
  const text = toText(key)
  if (text === "__proto__") return "['__proto__']"
  if (isIdentifier(text)) return text
  return quoteText(text)
}

const isIdentifierStart = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
const isIdentifier = (text: string): boolean => {
  if (text.length === 0 || !isIdentifierStart(codeAt(text, 0))) return false
  for (let index = 1; index < text.length; index++) {
    const code = codeAt(text, index)
    if (!isIdentifierStart(code) && (code < 48 || code > 57)) return false
  }
  return true
}

/** An array index key: digits with no leading zero, below 2^32 - 1. */
const indexOfKey = (key: PropertyKey): Option.Option<number> => {
  if (!Predicate.isString(key) || key.length === 0 || key.length > 10) return Option.none()
  if (key.length > 1 && codeAt(key, 0) === 48) return Option.none()
  let index = 0
  for (let position = 0; position < key.length; position++) {
    const code = codeAt(key, position)
    if (code < 48 || code > 57) return Option.none()
    index = index * 10 + (code - 48)
  }
  if (index > 4_294_967_294) return Option.none()
  return Option.some(index)
}

const remainingItems = (remaining: number): string =>
  `... ${remaining} more ${plural(remaining, "item", "items")}`

// ── display: names ──

const functionName = (value: unknown): string => {
  if (!Predicate.isFunction(value) || isProxy(value)) return ""
  const name = dataValue(value, "name")
  if (Option.isSome(name) && Predicate.isString(name.value)) return name.value
  return ""
}

/** A constructor found by an own `constructor` data property whose prototype the value inherits. */
const constructorAt = (holder: object, value: object): Option.Option<string> => {
  const descriptor = ownDescriptor(holder, "constructor")
  if (Predicate.isUndefined(descriptor) || !hasOwn(descriptor, "value")) return Option.none()
  const constructor: unknown = descriptor.value
  const name = functionName(constructor)
  if (name === "" || !Predicate.isFunction(constructor)) return Option.none()
  const prototype = dataValue(constructor, "prototype")
  if (Option.isNone(prototype) || !Predicate.isObjectKeyword(prototype.value)) return Option.none()
  if (!Result.getOrElse(inheritsFrom(value, prototype.value), () => false)) return Option.none()
  return Option.some(name)
}

/** The name `inspect` gives a value's constructor, found along the prototype chain. */
const constructorName = (value: object): ConstructorName => {
  let holder: unknown = value
  for (let depth = 0; depth < PROTOTYPE_DEPTH_LIMIT; depth++) {
    if (!Predicate.isObjectKeyword(holder)) {
      if (depth === 1) return null
      return "Object <Complex prototype>"
    }
    if (isProxy(holder)) return unreadablePrototype
    const found = constructorAt(holder, value)
    if (Option.isSome(found)) return found.value
    holder = prototypeOf(holder)
  }
  return unreadablePrototype
}

/** A `Symbol.toStringTag` held as data and not as an own enumerable property; a getter is never run. */
const tagOf = (value: object): string => {
  const own = ownDescriptor(value, Symbol.toStringTag)
  if (Predicate.isNotUndefined(own) && own.enumerable === true) return ""
  const tag = dataValue(value, Symbol.toStringTag)
  if (Option.isSome(tag) && Predicate.isString(tag.value)) return tag.value
  return ""
}

const prototypeLabel = (constructor: null | typeof unreadablePrototype): string => {
  if (constructor === null) return "null prototype"
  return "unreadable prototype"
}

const getPrefix = (
  constructor: ConstructorName,
  tag: string,
  fallback: string,
  size = "",
): string => {
  if (!Predicate.isString(constructor)) {
    const label = prototypeLabel(constructor)
    if (tag !== "" && fallback !== tag) return `[${fallback}${size}: ${label}] [${tag}] `
    return `[${fallback}${size}: ${label}] `
  }
  if (tag !== "" && constructor !== tag) return `${constructor}${size} [${tag}] `
  return `${constructor}${size} `
}

const constructorLabel = (constructor: ConstructorName): string => {
  if (Predicate.isString(constructor)) return constructor
  return `Object: ${prototypeLabel(constructor)}`
}

const depthMarker = (constructor: ConstructorName): string => `[${constructorLabel(constructor)}]`

// ── display: keys and properties ──

/** Own enumerable keys, strings first and then symbols, as `inspect` lists them. */
const keysOf = (value: object, skipIndexes: boolean): Array<PropertyKey> => {
  const all = ownKeys(value)
  const keys: Array<PropertyKey> = []
  for (let index = 0; index < all.length; index++) {
    const key = all[index]
    if (key === undefined) continue
    if (skipIndexes && Option.isSome(indexOfKey(key))) continue
    const descriptor = ownDescriptor(value, key)
    if (Predicate.isNotUndefined(descriptor) && descriptor.enumerable === true) append(keys, key)
  }
  return keys
}

/** Extra keys of an array-like value; a long one lists none, since listing reads every index key. */
const extraKeysOf = (value: object, length: number): Array<PropertyKey> => {
  if (length > displayKeyScanLength) return []
  return keysOf(value, true)
}

const accessorText = (descriptor: PropertyDescriptor): string => {
  const get = Predicate.isNotUndefined(descriptorField(descriptor, "get"))
  const set = Predicate.isNotUndefined(descriptorField(descriptor, "set"))
  if (get && set) return "[Getter/Setter]"
  if (get) return "[Getter]"
  if (set) return "[Setter]"
  return "undefined"
}

const formatNested = (context: DisplayContext, value: unknown, depth: number): string => {
  context.indentation += 2
  const text = formatValue(context, value, depth)
  context.indentation -= 2
  return text
}

const propertyText = (
  context: DisplayContext,
  holder: object,
  key: PropertyKey,
  depth: number,
): string => {
  const descriptor = ownDescriptor(holder, key)
  if (Predicate.isUndefined(descriptor)) return "undefined"
  if (hasOwn(descriptor, "value")) return formatNested(context, descriptor.value, depth)
  return accessorText(descriptor)
}

const formatProperty = (
  context: DisplayContext,
  holder: object,
  key: PropertyKey,
  depth: number,
): string => `${keyText(key)}: ${propertyText(context, holder, key, depth)}`

// ── display: lists ──

/** The next own index at or after `from`; `length` when none. */
const nextOwnIndex = (value: object, from: number, length: number): number => {
  const scanEnd = smallest(length, from + holeScanLength)
  for (let index = from; index < scanEnd; index++) if (hasOwn(value, index)) return index
  if (scanEnd === length) return length
  const keys = ownKeys(value)
  let next = length
  for (let position = 0; position < keys.length; position++) {
    const index = indexOfKey(itemAt(keys, position, ""))
    if (Option.isSome(index) && index.value >= from && index.value < next) next = index.value
  }
  return next
}

/** An array's items: at most 100, a run of holes as `<n empty items>`. */
const arrayItems =
  (value: object, length: number) =>
  (context: DisplayContext, depth: number): Array<string> => {
    const output: Array<string> = []
    let index = 0
    while (index < length && output.length < displayListLength) {
      if (hasOwn(value, index)) {
        append(output, propertyText(context, value, toText(index), depth))
        index++
        continue
      }
      const next = nextOwnIndex(value, index, length)
      const empty = next - index
      append(output, `<${empty} empty ${plural(empty, "item", "items")}>`)
      index = next
    }
    if (index < length) append(output, remainingItems(length - index))
    return output
  }

const typedArrayItems =
  (value: object, length: number) =>
  (_context: DisplayContext, _depth: number): Array<string> => {
    const output: Array<string> = []
    const shown = smallest(displayListLength, length)
    for (let index = 0; index < shown; index++) {
      const item = typedArrayItem(value, index)
      if (Predicate.isBigInt(item)) append(output, `${toText(item)}n`)
      else if (Predicate.isNumber(item)) append(output, formatNumber(item))
    }
    if (length > shown) append(output, remainingItems(length - shown))
    return output
  }

const collectionItems =
  (
    collection: { readonly size: number; readonly members: ReadonlyArray<CollectionMember> },
    map: boolean,
  ) =>
  (context: DisplayContext, depth: number): Array<string> => {
    const output: Array<string> = []
    context.indentation += 2
    for (let index = 0; index < collection.members.length; index++) {
      const member = collection.members[index]
      if (member === undefined) continue
      if (map)
        append(
          output,
          `${formatValue(context, member.key, depth)} => ${formatValue(context, member.value, depth)}`,
        )
      else append(output, formatValue(context, member.value, depth))
    }
    context.indentation -= 2
    const remaining = collection.size - collection.members.length
    if (remaining > 0) append(output, remainingItems(remaining))
    return output
  }

const promiseItems =
  (value: object) =>
  (context: DisplayContext, depth: number): Array<string> =>
    Option.match(context.options.promiseState(value), {
      onNone: () => ["<unknown>"],
      onSome: (state) => {
        if (state.status === "pending") return ["<pending>"]
        const text = formatNested(context, state.value, depth)
        if (state.status === "rejected") return [`<rejected> ${text}`]
        return [text]
      },
    })

const bufferItems =
  (value: object) =>
  (_context: DisplayContext, _depth: number): Array<string> => {
    const bytes = Option.liftThrowable((): object => construct(ByteView, [value]))()
    if (Option.isNone(bytes)) return ["(detached)"]
    const length = call(typedArrayLength, bytes.value)
    if (!Predicate.isNumber(length)) return ["(detached)"]
    const shown = smallest(displayListLength, length)
    const pairs: Array<string> = []
    for (let index = 0; index < shown; index++) {
      const byte = typedArrayItem(bytes.value, index)
      if (Predicate.isNumber(byte)) append(pairs, hex(byte, 2, hexDigits))
    }
    let contents = join(pairs, " ")
    if (length > shown)
      contents += ` ... ${length - shown} more ${plural(length - shown, "byte", "bytes")}`
    return [`[Uint8Contents]: <${contents}>`, `[byteLength]: ${formatNumber(length)}`]
  }

// ── display: bases ──

const isClassSource = (source: string): boolean => {
  if (source.length < 6 || slice(source, 0, 5) !== "class") return false
  const next = codeAt(source, 5)
  if (next !== 32 && next !== 123 && next !== 9 && next !== 10) return false
  return codeAt(source, source.length - 1) === 125
}

const classBase = (value: Function, constructor: ConstructorName, tag: string): string => {
  const own = ownDescriptor(value, "name")
  let name = "(anonymous)"
  if (Predicate.isNotUndefined(own) && Predicate.isString(descriptorField(own, "value")))
    name = toText(descriptorField(own, "value"))
  if (name === "") name = "(anonymous)"
  let base = `class ${name}`
  if (constructor !== "Function" && constructor !== null)
    base += ` [${constructorLabel(constructor)}]`
  if (tag !== "" && constructor !== tag) base += ` [${tag}]`
  if (constructor === null) return `[${base} extends [null prototype]]`
  const parent = functionName(prototypeOf(value))
  if (parent !== "") base += ` extends ${parent}`
  return `[${base}]`
}

const functionBase = (value: Function, constructor: ConstructorName, tag: string): string => {
  const source = Option.liftThrowable(() => call(functionSource, value))()
  if (Option.isSome(source) && Predicate.isString(source.value) && isClassSource(source.value))
    return classBase(value, constructor, tag)
  let type = "Function"
  if (isGeneratorFunction(value)) type = `Generator${type}`
  if (isAsyncFunction(value)) type = `Async${type}`
  let base = `[${type}`
  if (constructor === null) base += " (null prototype)"
  const name = functionName(value)
  if (name === "") base += " (anonymous)"
  else base += `: ${name}`
  base += "]"
  if (constructor !== type && Predicate.isString(constructor)) base += ` ${constructor}`
  if (tag !== "" && constructor !== tag) base += ` [${tag}]`
  return base
}

const boxedBase = (
  context: DisplayContext,
  value: object,
  constructor: ConstructorName,
  tag: string,
): string => {
  let type = "Symbol"
  let unbox = symbolValue
  if (isNumberObject(value)) {
    type = "Number"
    unbox = numberValue
  } else if (isStringObject(value)) {
    type = "String"
    unbox = stringValue
  } else if (isBooleanObject(value)) {
    type = "Boolean"
    unbox = booleanValue
  } else if (isBigIntObject(value)) {
    type = "BigInt"
    unbox = bigIntValue
  }
  let base = `[${type}`
  if (type !== constructor) {
    if (Predicate.isString(constructor)) base += ` (${constructor})`
    else base += ` (${prototypeLabel(constructor)})`
  }
  const inner = call(unbox, value)
  base += `: ${formatPrimitive(context, inner)}]`
  if (tag !== "" && tag !== constructor) base += ` [${tag}]`
  return base
}

const dateBase = (value: object, constructor: ConstructorName, tag: string): string => {
  const time = readDate(value)
  let base = "Invalid Date"
  if (Option.isSome(time) && !isNotANumber(time.value)) {
    const iso = call(dateIso, value)
    if (Predicate.isString(iso)) base = iso
  }
  const prefix = getPrefix(constructor, tag, "Date")
  if (prefix !== "Date ") return prefix + base
  return base
}

const regExpBase = (value: object, constructor: ConstructorName, tag: string): string => {
  const read = readRegExp(value)
  let base = unreadableDisplay
  if (Option.isSome(read)) base = `/${read.value.source}/${read.value.flags}`
  const prefix = getPrefix(constructor, tag, "RegExp")
  if (prefix !== "RegExp ") return prefix + base
  return base
}

const errorBase = (value: object): string =>
  Option.match(Option.liftThrowable(() => errorHead(value))(), {
    onNone: () => unreadableDisplay,
    onSome: (head) => `[${head}]`,
  })

const isErrorValue = (value: object): boolean =>
  isNativeError(value) || Result.getOrElse(inheritsFrom(value, errorPrototype), () => false)

// ── display: layouts ──

const layout = (fields: Partial<Layout> & Pick<Layout, "open" | "close" | "keys">): Layout => ({
  base: "",
  list: false,
  items: noItems,
  ...fields,
})

const collectionName = (value: object): string => {
  if (isMap(value)) return "Map"
  return "Set"
}

const weakCollectionName = (value: object): string => {
  if (isWeakMap(value)) return "WeakMap"
  return "WeakSet"
}

/** An array, Map, Set or typed array; none for any other value. */
const listLayout = (
  value: object,
  constructor: ConstructorName,
  tag: string,
): Option.Option<Layout | string> => {
  if (isArray(value)) {
    const length = value.length
    const keys = extraKeysOf(value, length)
    let prefix = ""
    if (constructor !== "Array" || tag !== "")
      prefix = getPrefix(constructor, tag, "Array", `(${length})`)
    if (length === 0 && keys.length === 0) return Option.some(`${prefix}[]`)
    return Option.some(
      layout({
        open: `${prefix}[`,
        close: "]",
        keys,
        list: true,
        items: arrayItems(value, length),
      }),
    )
  }
  const collection = readCollection(value, displayListLength)
  if (Option.isSome(collection)) {
    const fallback = collectionName(value)
    const keys = keysOf(value, false)
    const prefix = getPrefix(constructor, tag, fallback, `(${collection.value.size})`)
    if (collection.value.size === 0 && keys.length === 0) return Option.some(`${prefix}{}`)
    return Option.some(
      layout({
        open: `${prefix}{`,
        close: "}",
        keys,
        items: collectionItems(collection.value, isMap(value)),
      }),
    )
  }
  const typed = readTypedArray(value)
  if (Option.isNone(typed)) return Option.none()
  const { kind, length } = typed.value
  const keys = extraKeysOf(value, length)
  const open = `${getPrefix(constructor, kind, kind, `(${length})`)}[`
  if (length === 0 && keys.length === 0) return Option.some(`${open}]`)
  return Option.some(
    layout({ open, close: "]", keys, list: true, items: typedArrayItems(value, length) }),
  )
}

/** A value shown by a base: a function, a regular expression, a date, an error or a boxed primitive. */
const baseOf = (
  context: DisplayContext,
  value: object,
  constructor: ConstructorName,
  tag: string,
): Option.Option<string> => {
  if (Predicate.isFunction(value)) return Option.some(functionBase(value, constructor, tag))
  if (isRegExp(value)) return Option.some(regExpBase(value, constructor, tag))
  if (isDate(value)) return Option.some(dateBase(value, constructor, tag))
  if (isErrorValue(value)) return Option.some(errorBase(value))
  if (isBoxedPrimitive(value)) return Option.some(boxedBase(context, value, constructor, tag))
  return Option.none()
}

/** An object shown by braces: a promise, a weak collection, a buffer or any other object. */
const braceLayout = (value: object, constructor: ConstructorName, tag: string): Layout | string => {
  const keys = keysOf(value, false)
  if (isAnyArrayBuffer(value))
    return layout({
      open: `${getPrefix(constructor, tag, "ArrayBuffer")}{`,
      close: "}",
      keys,
      items: bufferItems(value),
    })
  if (isPromise(value))
    return layout({
      open: `${getPrefix(constructor, tag, "Promise")}{`,
      close: "}",
      keys,
      items: promiseItems(value),
    })
  if (isWeakMap(value) || isWeakSet(value)) {
    const fallback = weakCollectionName(value)
    return layout({
      open: `${getPrefix(constructor, tag, fallback)}{`,
      close: "}",
      keys,
      items: () => ["<items unknown>"],
    })
  }
  let open = `${getPrefix(constructor, tag, "Object")}{`
  if (constructor === "Object") {
    open = "{"
    if (tag !== "") open = `${getPrefix(constructor, tag, "Object")}{`
    if (isArgumentsObject(value)) open = "[Arguments] {"
  }
  if (keys.length === 0) return `${open}}`
  return layout({ open, close: "}", keys })
}

const layoutOf = (
  context: DisplayContext,
  value: object,
  constructor: ConstructorName,
): Layout | string => {
  const tag = tagOf(value)
  const list = listLayout(value, constructor, tag)
  if (Option.isSome(list)) return list.value
  if (constructor !== "Object") {
    const base = baseOf(context, value, constructor, tag)
    if (Option.isSome(base)) {
      const keys = keysOf(value, isStringObject(value))
      if (keys.length === 0) return base.value
      return layout({ base: base.value, open: "{", close: "}", keys })
    }
  }
  return braceLayout(value, constructor, tag)
}

// ── display: joining ──

const isBelowBreakLength = (
  output: ReadonlyArray<string>,
  start: number,
  base: string,
): boolean => {
  let total = output.length + start
  if (total + output.length > breakLength) return false
  for (let index = 0; index < output.length; index++) {
    total += itemAt(output, index, "").length
    if (total > breakLength) return false
  }
  return base === "" || !holdsCode(base, 10)
}

/** Whether every listed item of an array-like value is a number or a bigint: they align right. */
const numericItems = (value: object, count: number): boolean => {
  for (let index = 0; index < count; index++) {
    const descriptor = ownDescriptor(value, index)
    if (Predicate.isUndefined(descriptor) || !hasOwn(descriptor, "value")) return false
    const item: unknown = descriptor.value
    if (!Predicate.isNumber(item) && !Predicate.isBigInt(item)) return false
  }
  return true
}

const columnCount = (
  context: DisplayContext,
  lengths: ReadonlyArray<number>,
  totalLength: number,
  maxLength: number,
  outputLength: number,
): number => {
  const actualMax = maxLength + 2
  if (actualMax * 3 + context.indentation >= breakLength) return 1
  if (!(totalLength / actualMax > 5 || maxLength <= 6)) return 1
  const averageBias = squareRoot(actualMax - totalLength / lengths.length)
  const biasedMax = largest(actualMax - 3 - averageBias, 1)
  return smallest(
    roundNumber(squareRoot(2.5 * biasedMax * outputLength) / biasedMax),
    floorNumber((breakLength - context.indentation) / actualMax),
    compactLevels * 4,
    15,
  )
}

/** More than six array items in aligned columns, as `inspect` groups them. */
const groupArrayElements = (
  context: DisplayContext,
  output: ReadonlyArray<string>,
  value: object,
): ReadonlyArray<string> => {
  let outputLength = output.length
  if (displayListLength < output.length) outputLength--
  const lengths: Array<number> = []
  let totalLength = 0
  let maxLength = 0
  for (let index = 0; index < outputLength; index++) {
    const length = itemAt(output, index, "").length
    append(lengths, length)
    totalLength += length + 2
    if (maxLength < length) maxLength = length
  }
  const columns = columnCount(context, lengths, totalLength, maxLength, outputLength)
  if (columns <= 1) return output
  const widths: Array<number> = []
  for (let column = 0; column < columns; column++) {
    let width = 0
    for (let index = column; index < outputLength; index += columns)
      width = largest(width, itemAt(lengths, index, 0))
    append(widths, width + 2)
  }
  const alignRight = numericItems(value, output.length)
  const grouped: Array<string> = []
  for (let row = 0; row < outputLength; row += columns) {
    const end = smallest(row + columns, outputLength)
    let line = ""
    let index = row
    for (; index < end - 1; index++) {
      const cell = `${output[index]}, `
      if (alignRight) line += padStart(cell, itemAt(widths, index - row, 0))
      else line += padEnd(cell, itemAt(widths, index - row, 0))
    }
    if (alignRight) line += padStart(itemAt(output, index, ""), itemAt(widths, index - row, 0) - 2)
    else line += output[index]
    append(grouped, line)
  }
  if (displayListLength < output.length) append(grouped, output[outputLength])
  return grouped
}

const reduceToSingleString = (
  context: DisplayContext,
  output: ReadonlyArray<string>,
  view: Layout,
  depth: number,
  value: object,
): string => {
  const base = view.base
  let lines = output
  if (view.list && output.length > 6) lines = groupArrayElements(context, output, value)
  let lead = ""
  if (base !== "") lead = `${base} `
  if (context.currentDepth - depth < compactLevels && output.length === lines.length) {
    const start = lines.length + context.indentation + view.open.length + base.length + 10
    if (isBelowBreakLength(lines, start, base)) {
      const joined = join(lines, ", ")
      if (!holdsCode(joined, 10)) return `${lead}${view.open} ${joined} ${view.close}`
    }
  }
  const indentation = `\n${spaces(context.indentation)}`
  return `${lead}${view.open}${indentation}  ${join(lines, `,${indentation}  `)}${indentation}${view.close}`
}

// ── display: values ──

const circularIndex = (context: DisplayContext, value: object): number => {
  const position = positionOf(context.circular, value)
  if (position !== -1) return position + 1
  append(context.circular, value)
  return context.circular.length
}

const formatRaw = (context: DisplayContext, value: object, depth: number): string => {
  const constructor = constructorName(value)
  const view = layoutOf(context, value, constructor)
  if (Predicate.isString(view)) return view
  if (depth > displayDepth) return depthMarker(constructor)
  const next = depth + 1
  append(context.seen, value)
  context.currentDepth = next
  const output = view.items(context, next)
  const shown = smallest(view.keys.length, displayListLength)
  for (let index = 0; index < shown; index++)
    append(output, formatProperty(context, value, itemAt(view.keys, index, ""), next))
  const hidden = view.keys.length - shown
  if (hidden > 0) append(output, `... ${hidden} more ${plural(hidden, "property", "properties")}`)
  dropLast(context.seen)
  let base = view.base
  const reference = positionOf(context.circular, value)
  if (reference !== -1) {
    const marker = `<ref *${reference + 1}>`
    if (base === "") base = marker
    else base = `${marker} ${base}`
  }
  return reduceToSingleString(context, output, { ...view, base }, next, value)
}

const formatValue = (context: DisplayContext, value: unknown, depth: number): string => {
  if (!Predicate.isObjectKeyword(value)) return formatPrimitive(context, value)
  if (context.budget <= 0) return "..."
  context.budget--
  if (isProxy(value)) return "[Proxy]"
  if (holds(context.seen, value)) return `[Circular *${circularIndex(context, value)}]`
  return formatRaw(context, value, depth)
}

const noPromiseState = (): Option.Option<PromiseState> => Option.none()

const emptyContext = (): DisplayContext => ({
  options: { promiseState: noPromiseState },
  indentation: 0,
  currentDepth: 0,
  budget: displayBudget,
  seen: [],
  circular: [],
})

/**
 * A value as `inspect` would show it, read without running cell code. A host
 * getter that throws, the only code it runs that can, gives `[unreadable]`.
 */
export const displayValue = (value: unknown, options: DisplayOptions): string =>
  Option.getOrElse(
    Option.liftThrowable(() => formatValue({ ...emptyContext(), options }, value, 0))(),
    () => unreadableDisplay,
  )
