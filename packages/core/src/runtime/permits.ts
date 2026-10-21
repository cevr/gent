import {
  Clock,
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Order,
  Schema,
  type Scope,
  TxDeferred,
  TxRef,
} from "effect"

/** Server-global, case-sensitive names. No implicit reentrancy. */
export const PermitName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export type PermitName = typeof PermitName.Type
const PermitLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const PermitSpec = Schema.Struct({ name: PermitName, limit: PermitLimit })
export type PermitSpec = typeof PermitSpec.Type

const PermitHolder = Schema.Struct({ id: Schema.Int, acquiredAt: Schema.Finite })
const PermitWaiter = Schema.Struct({ id: Schema.Int, queuedAt: Schema.Finite })
export const PermitStatus = Schema.Struct({
  ...PermitSpec.fields,
  holders: Schema.Array(PermitHolder),
  waiters: Schema.Array(PermitWaiter),
})
export type PermitStatus = typeof PermitStatus.Type

export class PermitLimitMismatch extends Schema.TaggedError<
  PermitLimitMismatch,
  { readonly brand: unique symbol }
>()("PermitLimitMismatch", {
  permitName: PermitName,
  limit: PermitLimit,
  requestedLimit: PermitLimit,
}) {
  override get message() {
    return `Permit "${this.permitName}" has limit ${this.limit}, requested ${this.requestedLimit}`
  }
}

interface Waiter {
  readonly id: number
  readonly queuedAt: number
  readonly ready: TxDeferred.TxDeferred<boolean>
}
interface Entry {
  readonly limit: number
  readonly holders: ReadonlyArray<typeof PermitHolder.Type>
  readonly waiters: ReadonlyArray<Waiter>
}
interface Table {
  readonly nextId: number
  readonly names: HashMap.HashMap<string, Entry>
}

export class Permits extends Context.Service<
  Permits,
  {
    /** Closes the body's inner scope before releasing. Recursive acquisition is unsupported. */
    readonly with: <A, E, R>(
      name: string,
      limit: number,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PermitLimitMismatch | Schema.SchemaError, Exclude<R, Scope.Scope>>
    readonly list: Effect.Effect<ReadonlyArray<PermitStatus>>
  }
>()("@gent/core/src/runtime/permits") {
  /** Synchronous roots (the focused tool harness) own a fresh table too. */
  static makeUnsafe(): Permits["Service"] {
    const table = TxRef.makeUnsafe<Table>({ nextId: 1, names: HashMap.empty() })

    // Removal and every handoff commit together. A grant reserves capacity
    // before waking its waiter; interruption uses this same idempotent removal.
    const release = Effect.fn("Permits.release")(function* (name: string, id: number) {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.gen(function* () {
        const current = yield* TxRef.get(table)
        const found = HashMap.get(current.names, name)
        if (Option.isNone(found)) return
        const entry = found.value
        const holders = entry.holders.filter((holder) => holder.id !== id)
        const waiters = entry.waiters.filter((waiter) => waiter.id !== id)
        while (holders.length < entry.limit && waiters.length > 0) {
          const next = Option.getOrThrow(Option.fromUndefinedOr(waiters.shift()))
          holders.push({ id: next.id, acquiredAt: now })
          yield* TxDeferred.succeed(next.ready, true)
        }
        let names = HashMap.set(current.names, name, { limit: entry.limit, holders, waiters })
        if (holders.length === 0 && waiters.length === 0)
          names = HashMap.remove(current.names, name)
        yield* TxRef.set(table, { ...current, names })
      }).pipe(Effect.tx)
    })

    const run = Effect.fn("Permits.with")(function* <A, E, R>(
      name: string,
      limit: number,
      effect: Effect.Effect<A, E, R>,
    ) {
      yield* Schema.decodeEffect(PermitSpec)({ name, limit })
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const ready = yield* TxDeferred.make<boolean>()
          const id = yield* Effect.gen(function* () {
            const current = yield* TxRef.get(table)
            const found = HashMap.get(current.names, name)
            const entry = Option.getOrElse(found, (): Entry => ({
              limit,
              holders: [],
              waiters: [],
            }))
            if (entry.limit !== limit) {
              return yield* new PermitLimitMismatch({
                permitName: name,
                limit: entry.limit,
                requestedLimit: limit,
              })
            }
            const id = current.nextId
            const immediate = entry.waiters.length === 0 && entry.holders.length < limit
            let next: Entry = {
              ...entry,
              waiters: [...entry.waiters, { id, queuedAt: now, ready }],
            }
            if (immediate) next = { ...entry, holders: [...entry.holders, { id, acquiredAt: now }] }
            yield* TxRef.set(table, {
              nextId: id + 1,
              names: HashMap.set(current.names, name, next),
            })
            if (immediate) yield* TxDeferred.succeed(ready, true)
            return id
          }).pipe(Effect.tx)
          // Install before either interruptible wait or body. A grant racing
          // interruption is a holder that this finalizer removes exactly once.
          yield* Effect.addFinalizer(() => release(name, id))
          yield* restore(TxDeferred.await(ready))
          return yield* restore(effect)
        }).pipe(Effect.scoped),
      )
    })
    const list = Effect.fn("Permits.list")(function* () {
      const current = yield* TxRef.get(table)
      return Array.from(current.names, ([name, entry]): PermitStatus => ({
        name,
        limit: entry.limit,
        holders: entry.holders.map((holder) => ({ ...holder })),
        waiters: entry.waiters.map(({ id, queuedAt }) => ({ id, queuedAt })),
      })).sort((a, b) => Order.String(a.name, b.name))
    })
    return Permits.of({ with: run, list: list() })
  }

  static readonly Live = Layer.sync(Permits, () => Permits.makeUnsafe())
}
