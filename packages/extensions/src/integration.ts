/**
 * The integration gate (`@gent/integration`): one record per GitHub repo and
 * ref that says whether the ref's head is green, and the one way gent pushes
 * to it.
 *
 * `integration.push` runs inside the server permit
 * `integration:<repo>:<ref>` (limit 1). It refuses before any write when
 * `gh` is missing or signed out, reconciles the record with the remote head,
 * admits a push only when the gate is clear (or red, with `repairOf` naming
 * the red generation), checks that the commit fast-forwards the head, writes
 * `Integrating`, pushes with no force, and writes `AwaitingCi`. It returns
 * when the push is accepted; the CI wait holds no permit.
 *
 * The CI wait is polled on core's durable wake clock: the host branch's
 * record `integration:<digest>` fires this extension's `wakeDue`, which reads
 * the check runs and statuses of the exact pushed commit. Green is success on
 * every required context the branch protection and rulesets name; with no
 * readable required context, green is at least one success and no failure or
 * pending run among those reported. Green writes `Clear`, a failure writes
 * `Red`, and the host branch gets the outcome as a wake message. A `gh` error
 * keeps the gate blocked, records the error, and backs off (30 s doubling to
 * 5 min).
 *
 * A crash between the two writes leaves `Integrating`: the next poll, push or
 * fire reads the remote head and moves the record on (the candidate is the
 * head: awaiting CI; the old head is still there: back to the state before;
 * any other head: that head becomes the subject). Nothing pushes again by
 * itself. A head that someone else pushed is adopted as a new generation.
 *
 * A machine pushes through the `Integration` service as its own poller
 * (`poller: "caller"`): a wake record belongs to the extension that arms it,
 * so a machine run keeps its own record and calls `poll`.
 */
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { Migrator, SqlClient } from "effect/sql"
import {
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  omitUndefined,
  type ProcessError,
  request,
  runProcess,
  SessionId,
  tool,
  type WakeDueInput,
  WakeNext,
} from "@gent/core/extensions/api"

const INTEGRATION_EXTENSION_ID = ExtensionId.make("@gent/integration")

/** `metadata.customType` on the message that tells the host a gate went green or red. */
const INTEGRATION_MESSAGE_TYPE = "integration"

/** The wake record of a gate: the prefix and the digest of its key. */
const SOURCE_PREFIX = "integration:"

/** A poll of a pending CI comes this long after the one before. */
const POLL_INTERVAL = Duration.seconds(30)
/** A `gh` error backs off from `POLL_INTERVAL`, twice as long each time, at most this. */
const POLL_BACKOFF_MAX = Duration.minutes(5)
/** One `gh` or `git` read; the whole poll stays under the 30 s hook bound. */
const READ_TIMEOUT = Duration.seconds(12)
const PUSH_TIMEOUT = Duration.minutes(2)
/** How long a poll waits for a push in flight before it leaves `Integrating` to the next poll. */
const RECONCILE_PERMIT_WAIT = Duration.seconds(5)

/** No prompt waits on a terminal nobody reads. */
const PROCESS_ENV = {
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  GH_NO_UPDATE_NOTIFIER: "1",
}

// ── schema ──────────────────────────────────────────────────────────────────

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const GateKey = Schema.Struct({
  repo: Schema.String.annotate({ description: "The GitHub repository, owner/name." }),
  ref: Schema.String.annotate({ description: "The branch name, e.g. main." }),
})
export type GateKey = typeof GateKey.Type

/** A check run or commit status of the gate's commit, as the gate reads it. */
export const Check = Schema.Struct({
  context: Schema.String,
  conclusion: Schema.Literals(["success", "failure", "pending", "skipped", "neutral"]),
  url: Schema.optionalKey(Schema.String),
})
export type Check = typeof Check.Type

/**
 * Who polls the gate's CI. `integration`: this extension's wake record on
 * the branch; `caller`: the pusher (a machine run) polls it itself. `notify`:
 * the branch gets green or red as a wake message.
 */
const GateHost = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  poller: Schema.Literals(["integration", "caller"]),
  notify: Schema.Boolean,
})
type GateHost = typeof GateHost.Type

const ClearState = Schema.TaggedStruct("Clear", { sha: Schema.optionalKey(Sha) })
const RedState = Schema.TaggedStruct("Red", {
  generation: Generation,
  sha: Sha,
  failing: Schema.Array(Check),
})

/**
 * The gate. `Integrating`: written before the push; `prior` is the state a
 * refused push goes back to. `AwaitingCi`: the head is `sha`, its CI not yet
 * green or red; `adopted` when someone else pushed it.
 */
export const GateState = Schema.Union([
  ClearState,
  Schema.TaggedStruct("Integrating", {
    generation: Generation,
    candidate: Sha,
    expectedBase: Schema.optionalKey(Sha),
    requestId: Schema.String,
    prior: Schema.Union([ClearState, RedState]).pipe(Schema.toTaggedUnion("_tag")),
  }),
  Schema.TaggedStruct("AwaitingCi", { generation: Generation, sha: Sha, adopted: Schema.Boolean }),
  RedState,
]).pipe(Schema.toTaggedUnion("_tag"))
export type GateState = typeof GateState.Type
type Prior = Extract<GateState, { readonly _tag: "Integrating" }>["prior"]

/**
 * One gate. `generation` is the last generation assigned. `required`: the
 * required contexts read at the last push; absent when protection named none
 * or could not be read. `toldGeneration`: the last generation whose outcome
 * reached the host.
 */
export const GateRecord = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  generation: Generation,
  state: GateState,
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  host: Schema.optionalKey(GateHost),
  lastPush: Schema.optionalKey(
    Schema.Struct({ requestId: Schema.String, generation: Generation, sha: Sha }),
  ),
  lastCheck: Schema.optionalKey(
    Schema.Struct({
      at: Schema.Finite,
      error: Schema.optionalKey(Schema.String),
      failures: Schema.Int,
    }),
  ),
  nextPollAt: Schema.optionalKey(Schema.Finite),
  toldGeneration: Schema.optionalKey(Generation),
  cleared: Schema.optionalKey(
    Schema.Struct({
      at: Schema.Finite,
      reason: Schema.String,
      sessionId: SessionId,
      branchId: BranchId,
    }),
  ),
})
export type GateRecord = typeof GateRecord.Type

/** What a push returns at admission. `replayed`: a repeat of a request already taken. */
const PushResult = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  generation: Generation,
  sha: Sha,
  state: Schema.Literals(["Clear", "Integrating", "AwaitingCi", "Red"]),
  replayed: Schema.Boolean,
})
type PushResult = typeof PushResult.Type

// ── errors ──────────────────────────────────────────────────────────────────

/** The gate holds another generation: CI runs, or it is red and the push names no repair. */
class IntegrationBlocked extends Schema.TaggedError<
  IntegrationBlocked,
  { readonly brand: unique symbol }
>()("IntegrationBlocked", {
  repo: Schema.String,
  ref: Schema.String,
  state: GateState,
  message: Schema.String,
}) {}

/** `gh` is missing or signed out (refused before any write), or its API failed. */
class GhUnavailable extends Schema.TaggedError<GhUnavailable, { readonly brand: unique symbol }>()(
  "GhUnavailable",
  {
    reason: Schema.Literals(["missing", "unauthenticated", "api"]),
    message: Schema.String,
  },
) {}

/** The push was refused: not a fast-forward, or the remote said no. Nothing is red for it. */
class PushRefused extends Schema.TaggedError<PushRefused, { readonly brand: unique symbol }>()(
  "PushRefused",
  { message: Schema.String },
) {}

/** A local fault: the remote is not GitHub, the commit is unknown, the store failed. */
class IntegrationError extends Schema.TaggedError<
  IntegrationError,
  { readonly brand: unique symbol }
>()("IntegrationError", { message: Schema.String, cause: Schema.optional(Schema.Defect()) }) {}

const storageError = (message: string) => (cause: unknown) =>
  new IntegrationError({ message, cause })

// ── storage ─────────────────────────────────────────────────────────────────

const gatesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS integration_gates (
    repo TEXT NOT NULL,
    ref TEXT NOT NULL,
    record_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo, ref)
  )`)
})

const migrateGates = Migrator.make({})({
  loader: Migrator.fromRecord({ "1_integration_gates": gatesMigration }),
  table: "integration_migrations",
}).pipe(Effect.mapError(storageError("Integration table migration failed")))

const GateRow = Schema.Struct({
  record_json: Schema.fromJsonString(GateRecord),
  version: Schema.Int,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(GateRow))
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(GateRecord))

interface Stored {
  readonly record: GateRecord
  readonly version: number
}

interface IntegrationStoreService {
  readonly read: (key: GateKey) => Effect.Effect<Option.Option<Stored>, IntegrationError>
  readonly list: Effect.Effect<ReadonlyArray<Stored>, IntegrationError>
  /** Writes when the row still has `version` (none: no row yet); false when another write came first. */
  readonly write: (
    expected: Option.Option<number>,
    record: GateRecord,
  ) => Effect.Effect<boolean, IntegrationError>
}

/** The `integration_gates` table. Building it runs the migrations it lacks. */
export class IntegrationStore extends Context.Service<IntegrationStore, IntegrationStoreService>()(
  "@gent/extensions/src/integration/IntegrationStore",
) {
  static Live: Layer.Layer<IntegrationStore, IntegrationError, SqlClient.SqlClient> = Layer.effect(
    IntegrationStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateGates
      const decode = (rows: ReadonlyArray<unknown>) =>
        decodeRows(rows).pipe(
          Effect.map((decoded) =>
            decoded.map((row) => ({ record: row.record_json, version: row.version })),
          ),
          Effect.mapError(storageError("An integration record does not decode")),
        )
      return IntegrationStore.of({
        read: Effect.fn("IntegrationStore.read")(function* (key) {
          const rows = yield* sql`SELECT record_json, version FROM integration_gates
            WHERE repo = ${key.repo} AND ref = ${key.ref}`.pipe(
            Effect.mapError(storageError("Failed to read the integration record")),
          )
          return Option.fromUndefinedOr((yield* decode(rows))[0])
        }),
        list: Effect.gen(function* () {
          const rows =
            yield* sql`SELECT record_json, version FROM integration_gates ORDER BY repo, ref`.pipe(
              Effect.mapError(storageError("Failed to list the integration records")),
            )
          return yield* decode(rows)
        }).pipe(Effect.withSpan("IntegrationStore.list")),
        write: Effect.fn("IntegrationStore.write")(function* (expected, record) {
          const json = yield* encodeRecord(record).pipe(
            Effect.mapError(storageError("An integration record does not encode")),
          )
          const now = yield* Clock.currentTimeMillis
          const rows = yield* Option.match(expected, {
            onNone:
              () => sql`INSERT INTO integration_gates (repo, ref, record_json, version, updated_at)
              VALUES (${record.repo}, ${record.ref}, ${json}, 1, ${now})
              ON CONFLICT (repo, ref) DO NOTHING RETURNING repo`,
            onSome: (version) => sql`UPDATE integration_gates
              SET record_json = ${json}, version = version + 1, updated_at = ${now}
              WHERE repo = ${record.repo} AND ref = ${record.ref} AND version = ${version}
              RETURNING repo`,
          }).pipe(Effect.mapError(storageError("Failed to write the integration record")))
          return rows.length > 0
        }),
      })
    }),
  )
}

// ── processes ───────────────────────────────────────────────────────────────

const ghApi = (path: string) =>
  runProcess("gh", ["api", path], { env: PROCESS_ENV, extendEnv: true, timeout: READ_TIMEOUT })

const apiError = (what: string, detail: string) =>
  new GhUnavailable({ reason: "api", message: `gh could not read ${what}: ${detail.trim()}` })

/** `gh` is installed and signed in; checked before any write. */
const ghReady = Effect.gen(function* () {
  const result = yield* runProcess("gh", ["auth", "status"], {
    env: PROCESS_ENV,
    extendEnv: true,
    timeout: READ_TIMEOUT,
  }).pipe(
    Effect.mapError(
      (error) =>
        new GhUnavailable({ reason: "missing", message: `gh is not available: ${error.message}` }),
    ),
  )
  if (result.exitCode !== 0) {
    return yield* new GhUnavailable({
      reason: "unauthenticated",
      message: `gh is not signed in: ${(result.stderr || result.stdout).trim()}`,
    })
  }
})

const git = (cwd: string, args: ReadonlyArray<string>, timeout: Duration.Duration = READ_TIMEOUT) =>
  runProcess("git", args, { cwd, env: PROCESS_ENV, extendEnv: true, timeout })

/** owner/name from a GitHub remote URL (https, ssh, or scp form). */
const githubRepoOf = (url: string): Option.Option<string> => {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (Predicate.isNull(match)) return Option.none()
  return Option.some(`${match[1]}/${match[2]}`)
}

const HeadReply = Schema.fromJsonString(Schema.Struct({ object: Schema.Struct({ sha: Sha }) }))

/** The remote head of the ref, read from GitHub. */
const readHead = Effect.fn("Integration.readHead")(function* (key: GateKey) {
  const result = yield* ghApi(`repos/${key.repo}/git/ref/heads/${key.ref}`).pipe(
    Effect.mapError((error) => apiError(`the head of ${key.ref}`, error.message)),
  )
  if (result.exitCode !== 0) return yield* apiError(`the head of ${key.ref}`, result.stderr)
  const decoded = Schema.decodeOption(HeadReply)(result.stdout)
  if (Option.isNone(decoded)) return yield* apiError(`the head of ${key.ref}`, "unexpected reply")
  return decoded.value.object.sha
})

const ProtectionReply = Schema.fromJsonString(
  Schema.Struct({
    contexts: Schema.optionalKey(Schema.Array(Schema.String)),
    checks: Schema.optionalKey(Schema.Array(Schema.Struct({ context: Schema.String }))),
  }),
)
const RulesReply = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      parameters: Schema.optionalKey(
        Schema.Struct({
          required_status_checks: Schema.optionalKey(
            Schema.Array(Schema.Struct({ context: Schema.String })),
          ),
        }),
      ),
    }),
  ),
)

/**
 * The required contexts of the ref, from branch protection and rulesets.
 * None when neither can be read or neither names a context: green then reads
 * every reported run.
 */
const readRequired = Effect.fn("Integration.readRequired")(function* (key: GateKey) {
  const read = <A>(path: string, decode: (stdout: string) => Option.Option<A>) =>
    ghApi(path).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return Option.none<A>()
        return decode(result.stdout)
      }),
      Effect.orElseSucceed(() => Option.none<A>()),
    )
  const [protection, rules] = yield* Effect.all(
    [
      read(
        `repos/${key.repo}/branches/${key.ref}/protection/required_status_checks`,
        Schema.decodeOption(ProtectionReply),
      ),
      read(`repos/${key.repo}/rules/branches/${key.ref}`, Schema.decodeOption(RulesReply)),
    ],
    { concurrency: "unbounded" },
  )
  const contexts = new Set<string>()
  Option.map(protection, (found) => {
    for (const context of found.contexts ?? []) contexts.add(context)
    for (const check of found.checks ?? []) contexts.add(check.context)
  })
  Option.map(rules, (found) => {
    for (const rule of found) {
      if (rule.type !== "required_status_checks") continue
      for (const check of rule.parameters?.required_status_checks ?? []) contexts.add(check.context)
    }
  })
  if (contexts.size === 0) return Option.none<ReadonlyArray<string>>()
  return Option.some<ReadonlyArray<string>>([...contexts].sort())
})

const CheckRun = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  head_sha: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.OptionFromOptionalNullOr(Schema.String),
})
const CheckRunsReply = Schema.fromJsonString(Schema.Struct({ check_runs: Schema.Array(CheckRun) }))
const StatusReply = Schema.fromJsonString(
  Schema.Struct({
    sha: Schema.String,
    statuses: Schema.Array(
      Schema.Struct({
        context: Schema.String,
        state: Schema.String,
        target_url: Schema.OptionFromOptionalNullOr(Schema.String),
      }),
    ),
  }),
)

const conclusionOf = (
  status: string,
  conclusion: (typeof CheckRun.Type)["conclusion"],
): Check["conclusion"] => {
  if (status !== "completed") return "pending"
  switch (conclusion) {
    case "success":
      return "success"
    case "skipped":
      return "skipped"
    case "neutral":
      return "neutral"
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failure"
    default:
      return "pending"
  }
}

const statusConclusionOf = (state: string): Check["conclusion"] => {
  if (state === "success") return "success"
  if (state === "failure" || state === "error") return "failure"
  return "pending"
}

/** The check runs (latest per name) and statuses of exactly `sha`. */
const readChecks = Effect.fn("Integration.readChecks")(function* (key: GateKey, sha: string) {
  const what = `the checks of ${sha.slice(0, 12)}`
  const [runs, statuses] = yield* Effect.all(
    [
      ghApi(`repos/${key.repo}/commits/${sha}/check-runs?per_page=100`),
      ghApi(`repos/${key.repo}/commits/${sha}/status`),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError((error) => apiError(what, error.message)))
  if (runs.exitCode !== 0) return yield* apiError(what, runs.stderr)
  if (statuses.exitCode !== 0) return yield* apiError(what, statuses.stderr)
  const decodedRuns = Schema.decodeOption(CheckRunsReply)(runs.stdout)
  const decodedStatuses = Schema.decodeOption(StatusReply)(statuses.stdout)
  if (Option.isNone(decodedRuns) || Option.isNone(decodedStatuses)) {
    return yield* apiError(what, "unexpected reply")
  }
  // A re-run adds a run under the same name: the newest one counts.
  const latest = new Map<string, (typeof decodedRuns.value.check_runs)[number]>()
  for (const run of decodedRuns.value.check_runs) {
    if (run.head_sha !== sha) continue
    const before = latest.get(run.name)
    if (Predicate.isUndefined(before) || run.id > before.id) latest.set(run.name, run)
  }
  const checks: Array<Check> = [...latest.values()].map((run) => ({
    context: run.name,
    conclusion: conclusionOf(run.status, run.conclusion),
    ...omitUndefined({ url: Option.getOrUndefined(run.html_url) }),
  }))
  if (decodedStatuses.value.sha === sha) {
    for (const status of decodedStatuses.value.statuses) {
      checks.push({
        context: status.context,
        conclusion: statusConclusionOf(status.state),
        ...omitUndefined({ url: Option.getOrUndefined(status.target_url) }),
      })
    }
  }
  return checks
})

// ── verdict ─────────────────────────────────────────────────────────────────

const Verdict = Schema.TaggedUnion({
  Green: {},
  Red: { failing: Schema.Array(Check) },
  Pending: {},
})
type Verdict = typeof Verdict.Type

/**
 * Green, red or pending for one commit's checks. With required contexts:
 * each must succeed (skipped and neutral never satisfy one), and a failure
 * of one is red. Without: at least one success, no failure, nothing
 * pending; skipped and neutral runs report no outcome.
 */
export const verdictOf = (
  required: Option.Option<ReadonlyArray<string>>,
  checks: ReadonlyArray<Check>,
): Verdict => {
  if (Option.isSome(required)) {
    const named = required.value.map((context) => checks.find((check) => check.context === context))
    const failing = named.filter(
      (check): check is Check => Predicate.isNotUndefined(check) && check.conclusion === "failure",
    )
    if (failing.length > 0) return Verdict.cases.Red.make({ failing })
    if (named.every((check) => check?.conclusion === "success")) return Verdict.cases.Green.make({})
    return Verdict.cases.Pending.make({})
  }
  const failing = checks.filter((check) => check.conclusion === "failure")
  if (failing.length > 0) return Verdict.cases.Red.make({ failing })
  if (checks.some((check) => check.conclusion === "pending")) return Verdict.cases.Pending.make({})
  if (checks.some((check) => check.conclusion === "success")) return Verdict.cases.Green.make({})
  return Verdict.cases.Pending.make({})
}

// ── the gate ────────────────────────────────────────────────────────────────

const permitNameOf = (key: GateKey) => `integration:${key.repo}:${key.ref}`.slice(0, 256)

/** The gate's wake record: derived from its key, so a repeat arm writes the same record. */
const gateSourceOf = Effect.fn("Integration.sourceOf")(function* (key: GateKey) {
  const digest = yield* (yield* Crypto.Crypto).digest(
    "SHA-256",
    new TextEncoder().encode(`${key.repo}\u0000${key.ref}`),
  )
  return `${SOURCE_PREFIX}${Hex.encode(digest)}`
})

const freshRecord = (key: GateKey): GateRecord => ({
  repo: key.repo,
  ref: key.ref,
  generation: 0,
  state: GateState.cases.Clear.make({}),
})

/** The commit the gate holds, if any. */
const shaOf = (state: GateState): Option.Option<string> => {
  switch (state._tag) {
    case "Clear":
      return Option.fromUndefinedOr(state.sha)
    case "Integrating":
      return Option.some(state.candidate)
    case "AwaitingCi":
    case "Red":
      return Option.some(state.sha)
  }
}

/** The generation the gate's state is at; a clear gate is at the last one assigned. */
export const generationOf = (record: GateRecord) => {
  switch (record.state._tag) {
    case "Clear":
      return record.generation
    case "Integrating":
    case "AwaitingCi":
    case "Red":
      return record.state.generation
  }
}

const backoffAfter = (failures: number) =>
  Math.min(
    Duration.toMillis(POLL_INTERVAL) * 2 ** Math.max(0, failures - 1),
    Duration.toMillis(POLL_BACKOFF_MAX),
  )

/** The remote head became the gate's subject: someone else pushed it. */
const adopt = (record: GateRecord, head: string, now: number): GateRecord => {
  const generation = record.generation + 1
  return {
    ...record,
    generation,
    state: GateState.cases.AwaitingCi.make({ generation, sha: head, adopted: true }),
    lastCheck: { at: now, failures: 0 },
    nextPollAt: now,
  }
}

/**
 * A refused or rolled-back push: the state before it, the generation kept.
 * Nothing settled, so a clear prior counts as told: the host hears of no
 * outcome for a push that never landed.
 */
const restore = (record: GateRecord, prior: Prior): GateRecord => {
  const { lastPush: _lastPush, nextPollAt: _nextPollAt, ...rest } = record
  if (Predicate.isTagged(prior, "Clear")) {
    return { ...rest, state: prior, toldGeneration: record.generation }
  }
  return { ...rest, state: prior }
}

/**
 * The record moved on to the remote head, or the same record when the head
 * is what it expects. `Integrating` meets the head: the candidate is awaiting
 * CI, the expected base goes back to the state before, anything else is
 * adopted. Never pushes.
 */
const reconciled = (record: GateRecord, head: string, now: number): GateRecord => {
  const state = record.state
  switch (state._tag) {
    case "Integrating":
      if (head === state.candidate) {
        return {
          ...record,
          state: GateState.cases.AwaitingCi.make({
            generation: state.generation,
            sha: head,
            adopted: false,
          }),
          nextPollAt: now,
        }
      }
      if (head === state.expectedBase) return restore(record, state.prior)
      return adopt(record, head, now)
    case "Clear":
      if (Predicate.isUndefined(state.sha) || state.sha === head) return record
      return adopt(record, head, now)
    case "AwaitingCi":
    case "Red":
      if (state.sha === head) return record
      return adopt(record, head, now)
  }
}

const resultOf = (record: GateRecord, replayed: boolean): PushResult => ({
  repo: record.repo,
  ref: record.ref,
  generation: generationOf(record),
  sha: Option.getOrElse(shaOf(record.state), () => record.lastPush?.sha ?? "0".repeat(40)),
  state: record.state._tag,
  replayed,
})

/** What `push` takes. `poller` and `notify` name who waits for CI (`GateHost`). */
interface PushInput {
  /** The checkout the commit and the remote come from; default the caller's. */
  readonly cwd?: string
  readonly ref: string
  readonly sha?: string
  readonly remote?: string
  readonly requestId: string
  readonly repairOf?: number
  readonly poller: GateHost["poller"]
  readonly notify: boolean
}

const isSameHost = (
  host: GateRecord["host"],
  place: { readonly sessionId: SessionId; readonly branchId: BranchId },
) =>
  Predicate.isNotUndefined(host) &&
  host.sessionId === place.sessionId &&
  host.branchId === place.branchId

const makeIntegration = (store: IntegrationStoreService) => {
  /** Writes `next` over `stored`; a lost race fails, so the caller reads again. */
  const commit = Effect.fn("Integration.commit")(function* (
    stored: Option.Option<Stored>,
    next: GateRecord,
  ) {
    const won = yield* store.write(
      Option.map(stored, (found) => found.version),
      next,
    )
    if (!won) {
      return yield* new IntegrationError({
        message: `The integration record of ${next.repo}:${next.ref} changed under this write`,
      })
    }
    return next
  })

  /** The stored record read with the remote head, written when it moved on. */
  const reconcileStored = Effect.fn("Integration.reconcile")(function* (
    key: GateKey,
    stored: Option.Option<Stored>,
    head: string,
  ) {
    const now = yield* Clock.currentTimeMillis
    const record = Option.match(stored, {
      onNone: () => freshRecord(key),
      onSome: (found) => found.record,
    })
    const next = reconciled(record, head, now)
    if (next === record && Option.isSome(stored)) return record
    return yield* commit(stored, next)
  })

  /** Tells the host a generation went green or red, once. */
  const tell = Effect.fn("Integration.tell")(function* (key: GateKey) {
    const ctx = yield* ExtensionContext
    const stored = yield* store.read(key)
    if (Option.isNone(stored)) return
    const record = stored.value.record
    const state = record.state
    if (state._tag !== "Clear" && state._tag !== "Red") return
    const host = record.host
    if (Predicate.isUndefined(host) || !host.notify) return
    const generation = generationOf(record)
    if ((record.toldGeneration ?? -1) >= generation) return
    const source = yield* gateSourceOf(key)
    const content = tellText(key, state, generation)
    yield* ctx.Session.send({
      delivery: "queue",
      sessionId: host.sessionId,
      branchId: host.branchId,
      sourceId: `${source}:${generation}`,
      content,
      metadata: {
        customType: INTEGRATION_MESSAGE_TYPE,
        extensionId: INTEGRATION_EXTENSION_ID,
        details: { repo: key.repo, ref: key.ref, generation, state: state._tag },
      },
      wake: true,
    })
    yield* store.write(Option.some(stored.value.version), {
      ...record,
      toldGeneration: generation,
    })
  })

  /**
   * One poll of the gate: an `Integrating` record is reconciled under the
   * permit (a push in flight keeps it), an `AwaitingCi` record reads the head
   * and its commit's checks, and a settled record tells its host if it has
   * not yet. Returns the record after it.
   */
  const poll = Effect.fn("Integration.poll")(function* (key: GateKey) {
    const ctx = yield* ExtensionContext
    const first = yield* store.read(key)
    if (Option.isNone(first)) return Option.none<GateRecord>()
    if (first.value.record.state._tag === "Integrating") {
      yield* ctx.Permits.with(
        permitNameOf(key),
        1,
        Effect.gen(function* () {
          const stored = yield* store.read(key)
          if (Option.isNone(stored) || stored.value.record.state._tag !== "Integrating") return
          const head = yield* readHead(key)
          yield* reconcileStored(key, stored, head)
        }),
      ).pipe(
        Effect.timeoutOption(RECONCILE_PERMIT_WAIT),
        Effect.catchTag("GhUnavailable", (error) => noteError(key, error.message)),
      )
    }
    const stored = yield* store.read(key)
    if (Option.isNone(stored)) return Option.none<GateRecord>()
    const record = stored.value.record
    const state = record.state
    if (state._tag !== "AwaitingCi") {
      // A settled gate whose tell a crash lost tells on this fire.
      yield* tell(key)
      return Option.map(yield* store.read(key), (found) => found.record)
    }
    const now = yield* Clock.currentTimeMillis
    const read = yield* Effect.all([readHead(key), readChecks(key, state.sha)], {
      concurrency: "unbounded",
    }).pipe(Effect.result)
    if (read._tag === "Failure") {
      yield* noteError(key, read.failure.message)
      return Option.map(yield* store.read(key), (found) => found.record)
    }
    const [head, checks] = read.success
    let next: GateRecord
    if (head !== state.sha) {
      next = adopt(record, head, now)
    } else {
      const verdict = verdictOf(Option.fromUndefinedOr(record.required), checks)
      const { nextPollAt: _nextPollAt, ...rest } = record
      switch (verdict._tag) {
        case "Green":
          next = {
            ...rest,
            state: GateState.cases.Clear.make({ sha: state.sha }),
            lastCheck: { at: now, failures: 0 },
          }
          break
        case "Red":
          next = {
            ...rest,
            state: GateState.cases.Red.make({
              generation: state.generation,
              sha: state.sha,
              failing: verdict.failing,
            }),
            lastCheck: { at: now, failures: 0 },
          }
          break
        case "Pending":
          next = {
            ...rest,
            lastCheck: { at: now, failures: 0 },
            nextPollAt: now + Duration.toMillis(POLL_INTERVAL),
          }
          break
      }
    }
    yield* store.write(Option.some(stored.value.version), next)
    yield* tell(key)
    return Option.map(yield* store.read(key), (found) => found.record)
  })

  /** A failed read keeps the gate, records the error, and backs off. */
  const noteError = Effect.fn("Integration.noteError")(function* (key: GateKey, error: string) {
    const stored = yield* store.read(key)
    if (Option.isNone(stored)) return
    const now = yield* Clock.currentTimeMillis
    const failures = (stored.value.record.lastCheck?.failures ?? 0) + 1
    yield* Effect.logWarning("integration.poll.failed").pipe(
      Effect.annotateLogs({ repo: key.repo, ref: key.ref, error, failures }),
    )
    yield* store.write(Option.some(stored.value.version), {
      ...stored.value.record,
      lastCheck: { at: now, error, failures },
      nextPollAt: now + backoffAfter(failures),
    })
  })

  const push = Effect.fn("Integration.push")(function* (input: PushInput) {
    const ctx = yield* ExtensionContext
    // Missing or signed-out gh refuses before anything is written.
    yield* ghReady
    const cwd = input.cwd ?? ctx.cwd
    const remote = input.remote ?? "origin"
    const url = yield* git(cwd, ["remote", "get-url", remote]).pipe(
      Effect.mapError(storageError("git is not available")),
    )
    if (url.exitCode !== 0) {
      return yield* new IntegrationError({
        message: `No git remote ${remote}: ${url.stderr.trim()}`,
      })
    }
    const repo = githubRepoOf(url.stdout)
    if (Option.isNone(repo)) {
      return yield* new IntegrationError({
        message: `Remote ${remote} is not a GitHub repository: ${url.stdout.trim()}`,
      })
    }
    const revision = yield* git(cwd, [
      "rev-parse",
      "--verify",
      `${input.sha ?? "HEAD"}^{commit}`,
    ]).pipe(Effect.mapError(storageError("git is not available")))
    const sha = revision.stdout.trim()
    if (revision.exitCode !== 0 || !Schema.is(Sha)(sha)) {
      return yield* new IntegrationError({
        message: `Unknown commit ${input.sha ?? "HEAD"}: ${revision.stderr.trim()}`,
      })
    }
    const key: GateKey = { repo: repo.value, ref: input.ref }
    return yield* ctx.Permits.with(
      permitNameOf(key),
      1,
      Effect.gen(function* () {
        const head = yield* readHead(key)
        let record = yield* reconcileStored(key, yield* store.read(key), head)
        // The same request again: what the first one did, pushed once.
        if (record.lastPush?.requestId === input.requestId) return resultOf(record, true)
        // A gate that waits for CI is read once more here, so a pusher that
        // retries moves a gate nobody polls (an adopted head, a stopped run).
        if (record.state._tag === "AwaitingCi") {
          record = Option.getOrElse(yield* poll(key), () => record)
        }
        const state = record.state
        const admitted =
          state._tag === "Clear" ||
          (state._tag === "Red" &&
            Predicate.isNotUndefined(input.repairOf) &&
            input.repairOf === state.generation)
        if (!admitted || (state._tag !== "Clear" && state._tag !== "Red")) {
          return yield* new IntegrationBlocked({
            repo: key.repo,
            ref: key.ref,
            state,
            message: blockedMessage(key, state),
          })
        }
        if (head === sha) {
          return yield* new PushRefused({ message: `${sha} is already the head of ${key.ref}` })
        }
        const ancestry = yield* git(cwd, ["merge-base", "--is-ancestor", head, sha]).pipe(
          Effect.mapError(storageError("git is not available")),
        )
        if (ancestry.exitCode === 1) {
          return yield* new PushRefused({
            message: `${sha} does not fast-forward ${key.ref} at ${head}: rebase it onto the remote head`,
          })
        }
        if (ancestry.exitCode !== 0) {
          return yield* new PushRefused({
            message: `The remote head ${head} is not in the local repository: fetch ${remote} and rebase`,
          })
        }
        const required = yield* readRequired(key)
        const now = yield* Clock.currentTimeMillis
        const generation = record.generation + 1
        const host: GateHost = {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          poller: input.poller,
          notify: input.notify,
        }
        // The fire is armed before the first write, so a crash after it is
        // reconciled by the next fire with no turn.
        if (input.poller === "integration") {
          yield* ctx.Session.wakeAt({
            sourceId: yield* gateSourceOf(key),
            at: now + Duration.toMillis(POLL_INTERVAL),
          })
        }
        const { required: _required, cleared: _cleared, ...base } = record
        const integrating: GateRecord = {
          ...base,
          ...omitUndefined({ required: Option.getOrUndefined(required) }),
          generation,
          state: GateState.cases.Integrating.make({
            generation,
            candidate: sha,
            expectedBase: head,
            requestId: input.requestId,
            prior: state,
          }),
          host,
          lastPush: { requestId: input.requestId, generation, sha },
          nextPollAt: now + Duration.toMillis(POLL_INTERVAL),
        }
        const stored = yield* store.read(key)
        record = yield* commit(stored, integrating)
        const pushed = yield* git(
          cwd,
          ["push", remote, `${sha}:refs/heads/${key.ref}`],
          PUSH_TIMEOUT,
        ).pipe(
          Effect.map((result) => ({ accepted: result.exitCode === 0, detail: result.stderr })),
          Effect.catchTag("ProcessError", (error: ProcessError) =>
            Effect.succeed({ accepted: false, detail: error.message }),
          ),
        )
        if (pushed.accepted) {
          const current = yield* store.read(key)
          return resultOf(
            yield* commit(current, {
              ...record,
              state: GateState.cases.AwaitingCi.make({ generation, sha, adopted: false }),
            }),
            false,
          )
        }
        // The push said no, or its outcome is unknown: the remote head decides.
        const after = yield* readHead(key).pipe(Effect.option)
        if (Option.isNone(after)) {
          return yield* new PushRefused({
            message: `The push of ${sha} to ${key.ref} has no known outcome (${pushed.detail.trim()}); the gate reconciles it from the remote head`,
          })
        }
        const settled = yield* reconcileStored(key, yield* store.read(key), after.value)
        if (settled.state._tag === "AwaitingCi" && settled.state.sha === sha) {
          return resultOf(settled, false)
        }
        return yield* new PushRefused({
          message: `The remote refused ${sha} on ${key.ref}: ${pushed.detail.trim()}`,
        })
      }),
    )
  })

  const clear = Effect.fn("Integration.clear")(function* (input: {
    readonly repo: string
    readonly ref: string
    readonly reason: string
  }) {
    const ctx = yield* ExtensionContext
    const reason = input.reason.trim()
    if (reason.length === 0) {
      return yield* new IntegrationError({ message: "A clear needs a reason" })
    }
    const key: GateKey = { repo: input.repo, ref: input.ref }
    return yield* ctx.Permits.with(
      permitNameOf(key),
      1,
      Effect.gen(function* () {
        const stored = yield* store.read(key)
        if (Option.isNone(stored)) {
          return yield* new IntegrationError({ message: `No gate for ${key.repo}:${key.ref}` })
        }
        const now = yield* Clock.currentTimeMillis
        const record = stored.value.record
        const { nextPollAt: _nextPollAt, ...rest } = record
        const next: GateRecord = {
          ...rest,
          state: GateState.cases.Clear.make(
            omitUndefined({ sha: Option.getOrUndefined(shaOf(record.state)) }),
          ),
          // The host is not told about a generation cleared by hand.
          toldGeneration: generationOf(record),
          cleared: { at: now, reason, sessionId: ctx.sessionId, branchId: ctx.branchId },
        }
        yield* commit(stored, next)
        const host = record.host
        if (Predicate.isNotUndefined(host) && host.poller === "integration") {
          yield* ctx.Session.cancelWake({
            sourceId: yield* gateSourceOf(key),
            sessionId: host.sessionId,
            branchId: host.branchId,
          })
        }
        return next
      }),
    )
  })

  /** The pusher stopped waiting (a stopped run): a later loop open adopts the gate. */
  const release = Effect.fn("Integration.release")(function* (key: GateKey) {
    const ctx = yield* ExtensionContext
    const stored = yield* store.read(key)
    if (Option.isNone(stored) || !isSameHost(stored.value.record.host, ctx)) return
    const { host: _host, ...rest } = stored.value.record
    yield* store.write(Option.some(stored.value.version), rest)
  })

  const read = Effect.fn("Integration.read")(function* (key: GateKey) {
    return Option.map(yield* store.read(key), (found) => found.record)
  })

  return { push, poll, clear, release, read, list: store.list, tell }
}

const blockedMessage = (key: GateKey, state: GateState) =>
  Match.type<GateState>().pipe(
    Match.tagsExhaustive({
      Integrating: (found) =>
        `${key.repo}:${key.ref} has a push in flight (generation ${found.generation})`,
      AwaitingCi: (found) =>
        `${key.repo}:${key.ref} waits for CI on ${found.sha} (generation ${found.generation})`,
      Red: (found) =>
        `${key.repo}:${key.ref} is red at ${found.sha} (generation ${found.generation}); a fix pushes with repairOf ${found.generation}`,
      Clear: () => `${key.repo}:${key.ref} is clear`,
    }),
  )(state)

/** The message that tells a gate's host its generation settled. */
const tellText = (key: GateKey, state: GateState, generation: number) => {
  if (Predicate.isTagged(state, "Red")) {
    const failing = state.failing.map((check) => check.context).join(", ")
    return `Integration gate ${key.repo}:${key.ref} is red at ${state.sha} (generation ${generation}): ${failing} failed. Push a fix with integration.push and repairOf ${generation}.`
  }
  let at = "its head"
  if (Predicate.isTagged(state, "Clear") && Predicate.isString(state.sha)) at = state.sha
  return `Integration gate ${key.repo}:${key.ref} is green at ${at} (generation ${generation}).`
}

type IntegrationApi = ReturnType<typeof makeIntegration>

/**
 * The gate for other extensions: a machine pushes with `poller: "caller"`
 * and polls it itself. Read it with `Effect.serviceOption`.
 *
 * @effect-expect-leaking ExtensionContext | ChildProcessSpawner | Crypto
 */
export class Integration extends Context.Service<Integration, IntegrationApi>()(
  "@gent/extensions/src/integration",
) {
  static Live: Layer.Layer<Integration | IntegrationStore, IntegrationError, SqlClient.SqlClient> =
    Layer.effect(
      Integration,
      Effect.map(IntegrationStore, (store) => Integration.of(makeIntegration(store))),
    ).pipe(Layer.provideMerge(IntegrationStore.Live))
}

/** One per server: every place's pushes meet one record and one permit. */
const IntegrationResource = defineResource({
  id: "@gent/integration/gates",
  scope: "server",
  layer: Integration.Live,
})

// ── hooks ───────────────────────────────────────────────────────────────────

/**
 * The `wakeDue` hook: a gate this branch polls came due. Polls it and asks
 * for the next fire while CI runs; a settled gate tells its host once.
 */
export const gateDue = Effect.fn("Integration.due")(function* (input: WakeDueInput) {
  if (!input.sourceId.startsWith(SOURCE_PREFIX)) return WakeNext.cases.Done.make({})
  const ctx = yield* ExtensionContext
  const integration = yield* Integration
  const records = yield* integration.list
  const found = yield* Effect.findFirst(records, (stored) =>
    Effect.map(gateSourceOf(stored.record), (source) => source === input.sourceId),
  )
  if (Option.isNone(found)) return WakeNext.cases.Done.make({})
  const record = found.value.record
  if (!isSameHost(record.host, ctx) || record.host?.poller !== "integration") {
    return WakeNext.cases.Done.make({})
  }
  const after = yield* integration.poll(record)
  return nextFire(after, yield* Clock.currentTimeMillis)
})

const nextFire = (record: Option.Option<GateRecord>, now: number) => {
  if (Option.isNone(record)) return WakeNext.cases.Done.make({})
  const state = record.value.state
  if (Predicate.isTagged(state, "Clear") || Predicate.isTagged(state, "Red")) {
    // An outcome the host has not had yet is told on the next fire.
    const host = record.value.host
    if (host?.notify === true && (record.value.toldGeneration ?? -1) < generationOf(record.value)) {
      return WakeNext.cases.At.make({ at: now + 1_000 })
    }
    return WakeNext.cases.Done.make({})
  }
  return WakeNext.cases.At.make({
    at: Math.max(now, record.value.nextPollAt ?? now + Duration.toMillis(POLL_INTERVAL)),
  })
}

/**
 * The loop-open repair: every gate this branch polls gets its record again,
 * and a gate no branch waits for (its host gone, its pusher stopped) is
 * adopted by this branch, polled with no message.
 */
export const adoptGates = Effect.fn("Integration.adopt")(function* () {
  const ctx = yield* ExtensionContext
  const integration = yield* Integration
  const store = yield* IntegrationStore
  const now = yield* Clock.currentTimeMillis
  for (const stored of yield* integration.list) {
    const record = stored.record
    const waiting =
      Predicate.isTagged(record.state, "Integrating") ||
      Predicate.isTagged(record.state, "AwaitingCi")
    const untold =
      record.host?.notify === true && (record.toldGeneration ?? -1) < generationOf(record)
    if (Predicate.isUndefined(record.host)) {
      if (!waiting) continue
      const won = yield* store.write(Option.some(stored.version), {
        ...record,
        host: {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          poller: "integration",
          notify: false,
        },
      })
      if (!won) continue
    } else if (!isSameHost(record.host, ctx) || record.host.poller !== "integration") {
      continue
    } else if (!waiting && !untold) {
      continue
    }
    yield* ctx.Session.wakeAt({
      sourceId: yield* gateSourceOf(record),
      at: Math.max(now, record.nextPollAt ?? now),
    })
  }
})

/** A deleted session hosts no gate: its gates wait for a loop open to adopt them. */
const dropHostSession = Effect.fn("Integration.sessionDeleted")(function* (sessionId: SessionId) {
  const store = yield* IntegrationStore
  for (const stored of yield* store.list) {
    if (stored.record.host?.sessionId !== sessionId) continue
    const { host: _host, ...rest } = stored.record
    yield* store.write(Option.some(stored.version), rest)
  }
})

// ── tools and requests ──────────────────────────────────────────────────────

export const IntegrationPushTool = tool({
  id: "integration.push",
  resources: [IntegrationResource],
  description:
    "Push a commit to a GitHub branch through the integration gate: fast-forward only, never forced, one push per branch at a time. It returns when the push is accepted; green or red arrives later as a message that wakes you. Refused while the branch waits for CI or is red; a fix for a red branch passes repairOf with the red generation.",
  promptSnippet: "Push a commit to a gated GitHub branch",
  params: Schema.Struct({
    ref: Schema.String.annotate({ description: "The branch to push to, e.g. main." }),
    sha: Schema.optionalKey(
      Schema.String.annotate({ description: "The commit to push; default HEAD." }),
    ),
    remote: Schema.optionalKey(
      Schema.String.annotate({ description: "The git remote; default origin." }),
    ),
    repairOf: Schema.optionalKey(
      Schema.Int.annotate({ description: "The red generation this push fixes." }),
    ),
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Names this push: a repeat with the same id pushes nothing. Default the call id.",
      }),
    ),
  }),
  output: PushResult,
  execute: Effect.fn("IntegrationPushTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const requestId = params.requestId ?? ctx.toolCallId
    if (Predicate.isUndefined(requestId)) {
      return yield* new IntegrationError({ message: "integration.push needs a requestId" })
    }
    const integration = yield* Integration
    return yield* integration.push({
      ...omitUndefined({ sha: params.sha, remote: params.remote, repairOf: params.repairOf }),
      ref: params.ref,
      requestId,
      poller: "integration",
      notify: true,
    })
  }),
})

const IntegrationRpc = defineRequests(INTEGRATION_EXTENSION_ID, {
  Status: request({
    id: "integration.status",
    description: "The integration gates: each repo and ref, its state and generation",
    answersDuringTurn: true,
    input: Schema.Struct({
      repo: Schema.optionalKey(Schema.String),
      ref: Schema.optionalKey(Schema.String),
    }),
    output: Schema.Array(GateRecord),
    resources: [IntegrationResource],
    execute: (input) =>
      Effect.gen(function* () {
        const integration = yield* Integration
        const records = yield* integration.list
        return records
          .map((stored) => stored.record)
          .filter(
            (record) =>
              (Predicate.isUndefined(input.repo) || record.repo === input.repo) &&
              (Predicate.isUndefined(input.ref) || record.ref === input.ref),
          )
      }),
  }),
  Clear: request({
    id: "integration.clear",
    description:
      "Clear an integration gate by hand, with a reason the record keeps: for a CI that never reports",
    answersDuringTurn: true,
    input: Schema.Struct({ repo: Schema.String, ref: Schema.String, reason: Schema.String }),
    output: GateRecord,
    resources: [IntegrationResource],
    execute: (input) => Effect.flatMap(Integration, (integration) => integration.clear(input)),
  }),
})

// ── registration ────────────────────────────────────────────────────────────

const logFailure = (event: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logWarning(event).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
  )

export const IntegrationExtension = defineExtension({
  id: INTEGRATION_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", IntegrationResource)
    yield* host.register("tool", IntegrationPushTool)
    yield* host.register("request", IntegrationRpc.Status, IntegrationRpc.Clear)
    yield* host.on("wakeDue", (input) => gateDue(input))
    yield* host.on("loopOpen", () => adoptGates().pipe(logFailure("integration.adopt.failed")))
    yield* host.on("sessionDeleted", ({ sessionId }) =>
      dropHostSession(sessionId).pipe(logFailure("integration.session-deleted.failed")),
    )
  }),
})
