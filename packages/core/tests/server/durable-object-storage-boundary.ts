/**
 * A Durable Object's SQLite storage, faked over `bun:sqlite` for the hosted
 * storage tests.
 *
 * It keeps the rules a SQLite-backed Durable Object keeps: no transaction SQL
 * (`BEGIN`, `COMMIT`, `SAVEPOINT`, ...), only the PRAGMAs Cloudflare
 * documents, at most 100 bound parameters, at most 100 KB a statement, and
 * `transaction(closure)` as the one way to run statements together. A nested
 * `transaction` is a savepoint, as workerd's `_cf_savepoint_<n>`. An integer
 * reads back as a JavaScript number, as workerd's SQL API returns it.
 *
 * `sql.exec` throws and `transaction` returns a Promise, as the platform's do,
 * so this file is the tests' Promise edge for that API.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite"
import type { SqliteClient as DoSqliteClient } from "@effect/sql-sqlite-do"
import { Effect, Exit, Option, Predicate, Schema } from "effect"

// ── rules ───────────────────────────────────────────────────────────────────

/** workerd compiles SQLite with `SQLITE_MAX_VARIABLE_NUMBER` 100. */
const DO_MAX_BOUND_PARAMETERS = 100
const DO_MAX_STATEMENT_BYTES = 100 * 1024
/**
 * The PRAGMAs Cloudflare documents for SQLite-backed Durable Objects; the
 * authorizer refuses every other one (`journal_mode` and `synchronous` among
 * them: the platform owns durability).
 */
const DO_ALLOWED_PRAGMAS = new Set([
  "table_list",
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "defer_foreign_keys",
  "quick_check",
  "optimize",
  "case_sensitive_like",
  "legacy_alter_table",
  "reverse_unordered_selects",
])
const TRANSACTION_WORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"])

const DoRule = Schema.Literals([
  "transaction-statement",
  "pragma",
  "bound-parameters",
  "statement-size",
  "binding-type",
])
type DoRule = typeof DoRule.Type

/** What workerd's authorizer or binder throws for a statement it refuses. */
class DurableObjectSqlRefused extends Schema.TaggedError<DurableObjectSqlRefused>()(
  "DurableObjectSqlRefused",
  { rule: DoRule, detail: Schema.String },
) {
  override get message() {
    return `not authorized: Durable Object SQL refuses ${this.rule} (${this.detail})`
  }
}

/** What a storage call on an evicted activation meets. */
class DurableObjectReset extends Schema.TaggedError<DurableObjectReset>()(
  "DurableObjectReset",
  {},
) {
  override get message() {
    return "Durable Object reset: this activation's storage handle is gone"
  }
}

type DoViolation = {
  readonly rule: DoRule
  readonly detail: string
  readonly statement: string
}

/** `enforce`: a refused statement throws, as workerd does. `record`: it is recorded, and a refused PRAGMA or transaction statement is skipped. */
type DoMode = "enforce" | "record"

interface Refusal {
  readonly rule: DoRule
  readonly detail: string
  readonly skip: boolean
}

const stripLeadingComments = (statement: string) =>
  statement.replace(/^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "")

const leadingWord = (statement: string) =>
  Option.getOrElse(
    Option.map(
      Option.fromNullishOr(/^[A-Za-z_]+/.exec(stripLeadingComments(statement))),
      (match) => match[0],
    ),
    () => "",
  ).toUpperCase()

/** The statements of one `exec`: a trigger body keeps its own `;`. */
const statementsOf = (sql: string): ReadonlyArray<string> => {
  if (/^CREATE\s+TRIGGER/i.test(stripLeadingComments(sql))) return [sql]
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

const pragmaNamesOf = (statement: string): ReadonlyArray<string> => {
  const direct = Array.from(
    stripLeadingComments(statement).matchAll(/^PRAGMA\s+(?:\w+\.)?(\w+)/gi),
    (match) => match[1],
  )
  const functions = Array.from(statement.matchAll(/\bpragma_(\w+)\s*\(/gi), (match) => match[1])
  return [...direct, ...functions]
    .values()
    .filter(Predicate.isString)
    .map((name) => name.toLowerCase())
    .toArray()
}

/** The table a write statement changes; a CTE's target counts. */
const writtenTableOf = (statement: string): string =>
  Option.getOrElse(
    Option.flatMap(
      Option.fromNullishOr(
        /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)/i.exec(
          statement,
        ),
      ),
      (match) => Option.fromUndefinedOr(match[1]),
    ),
    () => `(${leadingWord(statement).toLowerCase()})`,
  )

/** A value workerd binds: a string, a number, a blob, or SQL NULL. */
const isDurableObjectBinding = (value: SQLQueryBindings) =>
  Predicate.isString(value) ||
  Predicate.isNumber(value) ||
  Predicate.isNull(value) ||
  value instanceof Uint8Array

const bindingKind = (value: SQLQueryBindings) => {
  if (Predicate.isBoolean(value)) return "boolean"
  if (Predicate.isBigInt(value)) return "bigint"
  return "other"
}

/** The rule `sql` with `bindings` breaks, if any. */
const ruleBroken = (
  sql: string,
  bindings: ReadonlyArray<SQLQueryBindings>,
): Option.Option<Refusal> => {
  if (new TextEncoder().encode(sql).length > DO_MAX_STATEMENT_BYTES)
    return Option.some({ rule: "statement-size", detail: `${sql.length} chars`, skip: false })
  for (const statement of statementsOf(sql)) {
    const word = leadingWord(statement)
    if (TRANSACTION_WORDS.has(word))
      return Option.some({ rule: "transaction-statement", detail: word, skip: true })
    const refused = pragmaNamesOf(statement).find((name) => !DO_ALLOWED_PRAGMAS.has(name))
    if (Predicate.isString(refused))
      return Option.some({ rule: "pragma", detail: refused, skip: word === "PRAGMA" })
  }
  if (bindings.length > DO_MAX_BOUND_PARAMETERS)
    return Option.some({
      rule: "bound-parameters",
      detail: `${bindings.length} bound`,
      skip: false,
    })
  const odd = bindings.filter((value) => !isDurableObjectBinding(value))
  if (odd.length > 0)
    return Option.some({
      rule: "binding-type",
      detail: odd.map(bindingKind).join(","),
      skip: false,
    })
  return Option.none()
}

/** A value the driver passes, as bun:sqlite binds it. An ArrayBuffer is a blob. */
const toBunBinding = (value: SQLQueryBindings | ArrayBuffer): SQLQueryBindings => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value
}

// ── storage ─────────────────────────────────────────────────────────────────

interface FakeCursor {
  readonly columnNames: Array<string>
  readonly raw: () => IterableIterator<Array<SQLQueryBindings>>
}

interface FakeTransaction {
  readonly rollback: () => void
}

/** The part of `DurableObjectStorage` the driver calls: `sql.exec` and `transaction`. */
export interface FakeDurableObjectStorage {
  readonly sql: {
    readonly exec: (sql: string, ...bindings: Array<SQLQueryBindings | ArrayBuffer>) => FakeCursor
    readonly databaseSize: number
  }
  readonly transaction: <T>(closure: (txn: FakeTransaction) => Promise<T>) => Promise<T>
}

type DoStorage = NonNullable<DoSqliteClient.SqliteClientConfig["storage"]>

/**
 * The driver reads only `sql.exec(...).columnNames`, `.raw()` and
 * `transaction`; KV, alarms and bookmarks are outside what gent reaches, so
 * the fake stands in for the platform type at this one point.
 */
export const asDurableObjectStorage = (fake: FakeDurableObjectStorage): DoStorage =>
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- a partial fake of a platform interface, read only through the members above
  fake as unknown as DoStorage

interface PhaseLedger {
  statements: number
  rowsReturned: number
  readonly rowsWritten: Map<string, number>
  refusedAfterEviction: number
}

const decodeChanges = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Finite }))
const PageRow = Schema.Struct({ page_count: Schema.Finite })
const PageSizeRow = Schema.Struct({ page_size: Schema.Finite })

const cursorOf = (
  columnNames: ReadonlyArray<string>,
  rows: ReadonlyArray<Array<SQLQueryBindings>>,
): FakeCursor => ({
  columnNames: [...columnNames],
  raw: () => rows.values(),
})

/**
 * One object's SQLite file. An activation is a storage handle over it; an
 * eviction kills the handle at once and discards its open transaction, and
 * the next activation opens a new handle over the same rows.
 */
export const makeDurableObjectDisk = (file: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const db = new Database(file, { create: true })
      // A Durable Object enforces foreign keys; bun:sqlite leaves them off.
      db.run("PRAGMA foreign_keys = ON")
      const violations: Array<DoViolation> = []
      const ledgers = new Map<string, PhaseLedger>()
      const transactions = { opened: 0, nested: 0, maxDepth: 0 }
      let phase = "boot"
      const ledger = () =>
        Option.getOrElse(Option.fromUndefinedOr(ledgers.get(phase)), () => {
          const created: PhaseLedger = {
            statements: 0,
            rowsReturned: 0,
            rowsWritten: new Map(),
            refusedAfterEviction: 0,
          }
          ledgers.set(phase, created)
          return created
        })
      const totalChanges = () => decodeChanges(db.query("SELECT total_changes() AS n").get()).n

      const activate = (mode: DoMode) => {
        let evicted = false
        let depth = 0

        const run = (sql: string, bindings: ReadonlyArray<SQLQueryBindings>) => {
          const before = totalChanges()
          const prepared = db.prepare(sql)
          const columns = prepared.columnNames
          let rows: ReadonlyArray<Array<SQLQueryBindings>> = []
          if (columns.length === 0 && bindings.length === 0) db.run(sql)
          else
            rows = Option.getOrElse(
              Option.fromNullishOr(prepared.values(...bindings)),
              (): Array<Array<SQLQueryBindings>> => [],
            )
          prepared.finalize()
          const entry = ledger()
          entry.rowsReturned += rows.length
          const written = totalChanges() - before
          if (written > 0) {
            const table = writtenTableOf(sql)
            entry.rowsWritten.set(table, (entry.rowsWritten.get(table) ?? 0) + written)
          }
          return cursorOf(columns, rows)
        }

        const exec = (sql: string, ...rawBindings: Array<SQLQueryBindings | ArrayBuffer>) => {
          if (evicted) {
            ledger().refusedAfterEviction += 1
            // oxlint-disable-next-line effect/noThrowStatement -- workerd's sql.exec throws; the driver reads it as a SqlError
            throw new DurableObjectReset()
          }
          const bindings = rawBindings.map(toBunBinding)
          const refusal = ruleBroken(sql, bindings)
          ledger().statements += 1
          if (Option.isNone(refusal)) return run(sql, bindings)
          violations.push({
            rule: refusal.value.rule,
            detail: refusal.value.detail,
            statement: sql.trim().replace(/\s+/g, " ").slice(0, 160),
          })
          if (mode === "enforce")
            // oxlint-disable-next-line effect/noThrowStatement -- workerd's sql.exec throws; the driver reads it as a SqlError
            throw new DurableObjectSqlRefused({
              rule: refusal.value.rule,
              detail: refusal.value.detail,
            })
          if (refusal.value.skip) return cursorOf([], [])
          return run(sql, bindings)
        }

        const openFrame = (level: number) => {
          if (level === 1) db.run("BEGIN")
          else db.run(`SAVEPOINT _cf_savepoint_${level}`)
        }
        const closeFrame = (level: number, commit: boolean) => {
          if (evicted) return
          if (level === 1 && commit) db.run("COMMIT")
          else if (level === 1) db.run("ROLLBACK")
          else if (commit) db.run(`RELEASE _cf_savepoint_${level}`)
          else db.run(`ROLLBACK TO _cf_savepoint_${level}; RELEASE _cf_savepoint_${level}`)
        }

        const transaction = <T>(closure: (txn: FakeTransaction) => Promise<T>): Promise<T> =>
          Effect.runPromise(
            Effect.gen(function* () {
              if (evicted) return yield* Effect.die(new DurableObjectReset())
              depth += 1
              const level = depth
              transactions.opened += 1
              if (level > 1) transactions.nested += 1
              transactions.maxDepth = Math.max(transactions.maxDepth, level)
              openFrame(level)
              let rollbackAsked = false
              const txn: FakeTransaction = {
                rollback: () => {
                  rollbackAsked = true
                },
              }
              const exit = yield* Effect.exit(Effect.tryPromise(() => closure(txn)))
              depth -= 1
              closeFrame(level, Exit.isSuccess(exit) && !rollbackAsked)
              return yield* exit
            }),
          )

        const storage: FakeDurableObjectStorage = {
          sql: {
            exec,
            get databaseSize() {
              const pages = Schema.decodeUnknownSync(PageRow)(db.query("PRAGMA page_count").get())
              const size = Schema.decodeUnknownSync(PageSizeRow)(db.query("PRAGMA page_size").get())
              return pages.page_count * size.page_size
            },
          },
          transaction,
        }

        const evict = () => {
          evicted = true
          if (db.inTransaction) db.run("ROLLBACK")
          depth = 0
        }

        return { storage, evict }
      }

      /** Reads rows straight from the file, outside the activation and its ledger. */
      const rowsOf = <A, I>(
        schema: Schema.Codec<A, I>,
        sql: string,
        ...params: ReadonlyArray<string | number>
      ): ReadonlyArray<A> =>
        Schema.decodeUnknownSync(Schema.Array(schema))(db.query(sql).all(...params))

      return {
        violations,
        ledgers,
        transactions,
        activate,
        rowsOf,
        setPhase: (next: string) => {
          phase = next
        },
        close: () => db.close(),
      }
    }),
    (disk) => Effect.sync(() => disk.close()),
  )

/**
 * Runs `body` in one `storage.transaction`, as the driver does; a nested
 * call is the platform's savepoint.
 */
export const inTransaction = (
  storage: FakeDurableObjectStorage,
  body: (txn: FakeTransaction) => Effect.Effect<void>,
) => Effect.promise(() => storage.transaction((txn) => Effect.runPromise(body(txn))))

export type DurableObjectDisk = Effect.Success<ReturnType<typeof makeDurableObjectDisk>>
