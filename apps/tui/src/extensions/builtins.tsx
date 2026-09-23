import {
  Clock,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  type Path,
  Queue,
  Schema,
} from "effect"
import { FileFinder, type SearchResult } from "@ff-labs/fff-bun"
import {
  type AnyExtensionClientModule,
  autocompleteContribution,
  borderLabelContribution,
  ClientActivity,
  type ClientActivitySnapshot,
  clientCommandContribution,
  clientContributions,
  ClientLifecycle,
  ClientShell,
  ClientTransport,
  ClientWorkspace,
  defineClientExtension,
  interactionRendererContribution,
  messageRendererContribution,
  rendererContribution,
  sessionQuery,
  widgetContribution,
} from "./client-facets.js"
import { truncate, truncatePath } from "../utils"
import { CollapsedRow, UserRow } from "../ui"
import { textWidth } from "../text-width-adapter"
import { BunSocket } from "@effect/platform-bun"
import { createEffect, createRoot, Show } from "solid-js"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "@gent/core/protocol"
import { ref } from "@gent/core/extensions/api"
import {
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  GoalRpc,
  type GoalSnapshot,
  remainingTokens,
  SESSION_MESSAGE_TYPE,
  SESSION_TOOLS_EXTENSION_ID,
  SessionMessageDetails,
  sessionMessageBody,
  SkillsRpc,
} from "@gent/extensions/client.js"
import { useTheme } from "../theme"
import { useClient } from "../client"
import { useExtensionUI } from "./host"
import { BUILTIN_TOOL_RENDERERS } from "../tool-renderers"
import { AskUserRenderer, HandoffRenderer, PromptRenderer } from "../interaction-renderers"
import builtinAgentsView from "./agents.client"
import builtinBtw from "./btw.client"
import builtinWake from "./wake.client"
import builtinThreadView from "./thread-view.client"
import {
  emptyFrecencyStore,
  frecencyLookup,
  rankAutocompleteItems,
  readFrecencyStore,
  recordFrecencyPick,
} from "../autocomplete"

// ── file tags ───────────────────────────────────────────────────────────────

interface FileTagGroup {
  readonly tag: string
  readonly extensions: ReadonlyArray<string>
}

const fileTagGroups = [
  { tag: "[ts]", extensions: ["ts", "tsx"] },
  { tag: "[js]", extensions: ["js", "jsx"] },
  { tag: "[md]", extensions: ["md", "mdx"] },
  { tag: "[json]", extensions: ["json"] },
  { tag: "[css]", extensions: ["css", "scss", "less"] },
  { tag: "[html]", extensions: ["html"] },
  { tag: "[py]", extensions: ["py"] },
  { tag: "[rs]", extensions: ["rs"] },
  { tag: "[go]", extensions: ["go"] },
  { tag: "[yaml]", extensions: ["yaml", "yml"] },
  { tag: "[toml]", extensions: ["toml"] },
  { tag: "[sh]", extensions: ["sh", "bash", "zsh"] },
] satisfies ReadonlyArray<FileTagGroup>

const fileTagByExtension = new Map<string, string>(
  fileTagGroups.flatMap(({ tag, extensions }) =>
    extensions.map((ext): readonly [string, string] => [ext, tag]),
  ),
)

export function getFileTag(path: string): string {
  const extension = Option.fromNullishOr(path.split(".").pop()).pipe(
    Option.map((value) => value.toLowerCase()),
    Option.flatMap((value) => Option.fromNullishOr(fileTagByExtension.get(value))),
  )
  return Option.getOrElse(extension, () => "")
}

// ── file finder ─────────────────────────────────────────────────────────────

/**
 * FileFinder — Effect-typed wrapper around the @ff-labs/fff-bun native finder.
 *
 * Exposes Effect-typed `searchFiles` and `trackSelection` over a per-cwd
 * cached `FileFinder` instance. The caller resolves the db directory once and
 * passes it in, so "where is the FFF db" is decided at the one place that
 * knows the workspace home.
 *
 * FFF is the *only* file-search path — there is no runtime glob fallback. If
 * `FileFinder.isAvailable()` is false the search Effect fails with
 * `FileFinderUnavailableError` and the popup adapter normalizes to `[]`.
 *
 * Scan readiness: each finder kicks off `waitForScan` once on creation,
 * stored as an Effect. The native call is wrapped so
 * a throwing call resolves to a typed failure object instead of leaving
 * the promise unresolved. The search effect
 * awaits via `Effect.promise` + a typed error map; Effect interruption
 * cleanly abandons the wait without canceling the underlying scan (which
 * is fine — the finder stays valid for the next search).
 */

// ── Errors ───────────────────────────────────────────────────────────────

class FileFinderUnavailableError extends Schema.TaggedError<FileFinderUnavailableError>()(
  "FileFinderUnavailableError",
  {},
) {}

class FileFinderInitError extends Schema.TaggedError<FileFinderInitError>()("FileFinderInitError", {
  reason: Schema.String,
}) {}

class FileFinderScanError extends Schema.TaggedError<FileFinderScanError>()("FileFinderScanError", {
  reason: Schema.String,
}) {}

// ── Singleton cache ──────────────────────────────────────────────────────

type ScanOutcome = { ok: true } | { ok: false; reason: string }

interface FinderEntry {
  readonly finder: FileFinder
  /** Completes when the initial scan completes. Always succeeds; failure
   *  modes are encoded in the returned value. */
  readonly scanReady: Effect.Effect<ScanOutcome>
}

const finders = new Map<string, FinderEntry>()

const ensureFinder = (
  cwd: string,
  dbDir: string,
): Effect.Effect<FinderEntry, FileFinderUnavailableError | FileFinderInitError> =>
  Effect.gen(function* () {
    const existing = Option.fromNullishOr(finders.get(cwd))
    if (Option.isSome(existing)) return existing.value

    if (!FileFinder.isAvailable()) {
      return yield* new FileFinderUnavailableError()
    }

    const result = FileFinder.create({
      basePath: cwd,
      frecencyDbPath: `${dbDir}/frecency.mdb`,
      historyDbPath: `${dbDir}/history.mdb`,
      aiMode: true,
    })

    if (!result.ok) {
      return yield* new FileFinderInitError({ reason: String(result.error) })
    }

    const finder = result.value

    // Yield one tick so finder.create returns synchronously to the first
    // search call before the blocking scan begins.
    const scanReady: Effect.Effect<ScanOutcome> = Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => finder.waitForScan(15_000),
          catch: String,
        }),
      ),
      Effect.match({
        onFailure: (reason) => ({ ok: false, reason }) satisfies ScanOutcome,
        onSuccess: (scan) => {
          if (scan.ok) return { ok: true } satisfies ScanOutcome
          return { ok: false, reason: "waitForScan returned !ok" } satisfies ScanOutcome
        },
      }),
    )

    const entry: FinderEntry = { finder, scanReady }
    finders.set(cwd, entry)
    return entry
  })

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Search for files matching `query` under `cwd`, keeping its frecency and
 * history databases in `dbDir`. Fails with a typed error if FFF is
 * unavailable, init failed, or the initial scan failed.
 */
export const searchFiles = (
  cwd: string,
  dbDir: string,
  query: string,
  pageSize: number = 50,
): Effect.Effect<
  SearchResult,
  FileFinderUnavailableError | FileFinderInitError | FileFinderScanError
> =>
  Effect.gen(function* () {
    const entry = yield* ensureFinder(cwd, dbDir)
    const outcome = yield* entry.scanReady
    if (!outcome.ok) {
      return yield* new FileFinderScanError({ reason: outcome.reason })
    }
    const result = entry.finder.fileSearch(query, { pageSize })
    if (!result.ok) {
      return yield* new FileFinderInitError({ reason: String(result.error) })
    }
    return result.value
  })

/** Track a selection for frecency learning. No-op if no finder for `cwd`. */
export const trackSelection = (cwd: string, query: string, filePath: string): void => {
  const entry = Option.fromNullishOr(finders.get(cwd))
  if (Option.isNone(entry)) return
  entry.value.finder.trackQuery(query, filePath)
}

// ── files extension ─────────────────────────────────────────────────────────

/**
 * Files autocomplete (`@`) — Effect-typed setup.
 *
 * Yields `ClientWorkspace` for cwd/home and `FileSystem.FileSystem` for the
 * empty-filter top-level directory listing. Non-empty filter goes through
 * the FFF-backed `searchFiles` Effect; there is no glob fallback.
 *
 * The FFF db directory is resolved once here, from the workspace home this
 * setup already yields, so the finder module never re-decides where it lives.
 */

const MAX_RESULTS = 50

const formatMatch = (f: { path: string; name: string }) => {
  const tag = getFileTag(f.path)
  let label = f.name
  if (tag.length > 0) label = `${tag} ${f.name}`
  return {
    id: f.path,
    label,
    description: truncatePath(f.path, 40),
  }
}

const builtinFiles = defineClientExtension("@gent/files-ui", {
  setup: Effect.gen(function* () {
    const workspace = yield* ClientWorkspace
    const fs = yield* FileSystem.FileSystem
    const dbDir = `${workspace.home}/.gent/fff`
    yield* Effect.ignore(fs.makeDirectory(dbDir, { recursive: true }))
    return autocompleteContribution({
      prefix: "@",
      title: "Files",
      items: (filter: string) =>
        Effect.gen(function* () {
          const cwd = workspace.cwd

          // Empty filter: list top-level directory entries via Effect FS.
          // Drops gitignore filtering at the top level — FFF respects
          // gitignore for the actual fuzzy search where it matters.
          if (filter.length === 0) {
            const entries = yield* Effect.orElseSucceed(
              fs.readDirectory(cwd),
              (): ReadonlyArray<string> => [],
            )
            return entries
              .filter((name: string) => !name.startsWith("."))
              .slice()
              .sort()
              .slice(0, MAX_RESULTS)
              .map((name: string) => formatMatch({ path: name, name }))
          }

          // Non-empty filter: FFF Effect. Failures (FFF unavailable, init
          // failure) are caught here so the popup adapter still shows []
          // instead of swallowing the failure as opaque.
          const fffResult = yield* Effect.option(searchFiles(cwd, dbDir, filter, MAX_RESULTS))
          if (Option.isNone(fffResult)) return []
          return fffResult.value.items.map((item: { relativePath: string; fileName: string }) =>
            formatMatch({ path: item.relativePath, name: item.fileName }),
          )
        }),
      onSelect: (id: string, filter: string) => {
        trackSelection(workspace.cwd, filter, id)
      },
    })
  }),
})

// ── herdr reporter ──────────────────────────────────────────────────────────

/** Ordered, bounded Herdr socket reports, owned by the TUI extension scope. */

const SOURCE = "herdr:gent"
const AGENT = "gent"
let herdrReportSequence = 0

const herdrEnvironment = Config.all({
  enabled: Config.string("HERDR_ENV").pipe(Config.withDefault("")),
  socketPath: Config.string("HERDR_SOCKET_PATH").pipe(Config.withDefault("")),
  paneId: Config.string("HERDR_PANE_ID").pipe(Config.withDefault("")),
}).pipe(
  Config.map((env) => {
    if (env.enabled !== "1" || env.socketPath.length === 0 || env.paneId.length === 0)
      return Option.none()
    return Option.some({ socketPath: env.socketPath, paneId: env.paneId })
  }),
)

interface HerdrTarget {
  readonly socketPath: string
  readonly paneId: string
}

class HerdrReportError extends Schema.TaggedError<HerdrReportError>()("HerdrReportError", {
  message: Schema.String,
}) {}

const Request = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Struct({
    pane_id: Schema.String,
    source: Schema.String,
    agent: Schema.String,
    seq: Schema.Finite,
    state: Schema.optional(Schema.String),
    agent_session_id: Schema.optional(Schema.String),
  }),
})
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request))

const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const sendRequest = Effect.fn("Herdr.sendRequest")(
  function* (target: HerdrTarget, request: typeof Request.Type) {
    const socket = yield* BunSocket.makeNet({ path: target.socketPath })
    const write = yield* socket.writer
    const reply = yield* Deferred.make<void, HerdrReportError>()
    let buffer = ""
    const read = socket
      .runString(
        (chunk) => {
          buffer += chunk
          if (buffer.length > 65_536)
            return Deferred.fail(
              reply,
              new HerdrReportError({ message: "Herdr reply exceeded the limit" }),
            )
          const end = buffer.indexOf("\n")
          if (end < 0) return Effect.void
          const decoded = Schema.decodeOption(Schema.fromJsonString(Reply))(buffer.slice(0, end))
          if (
            Option.isNone(decoded) ||
            decoded.value.id !== request.id ||
            Option.isSome(Option.fromUndefinedOr(decoded.value.error)) ||
            Option.isNone(Option.fromUndefinedOr(decoded.value.result))
          ) {
            return Deferred.fail(
              reply,
              new HerdrReportError({ message: "Herdr rejected the report" }),
            )
          }
          return Deferred.done(reply, Exit.void)
        },
        {
          onOpen: write(`${encodeRequest(request)}\n`).pipe(
            Effect.catchEager(() =>
              Deferred.fail(reply, new HerdrReportError({ message: "Herdr write failed" })),
            ),
            Effect.asVoid,
          ),
        },
      )
      .pipe(
        Effect.andThen(
          Effect.fail(new HerdrReportError({ message: "Herdr closed before replying" })),
        ),
      )
    yield* Effect.raceFirst(read, Deferred.await(reply))
  },
  Effect.scoped,
  Effect.timeout("500 millis"),
)

export const makeHerdrReporter = Effect.fn("Herdr.makeReporter")(function* (target: HerdrTarget) {
  const reports = yield* Queue.sliding<ClientActivitySnapshot>(1)
  let closed = false
  let previous = ""

  const send = Effect.fn("Herdr.report")(function* (
    method: string,
    snapshot?: ClientActivitySnapshot,
  ) {
    const now = yield* Clock.currentTimeMillis
    herdrReportSequence = Math.max(herdrReportSequence + 1, now * 1000)
    const seq = herdrReportSequence
    const params = {
      pane_id: target.paneId,
      source: SOURCE,
      agent: AGENT,
      seq,
      state: snapshot?.state,
      agent_session_id: snapshot?.sessionId,
    }
    yield* sendRequest(target, { id: `${SOURCE}:${seq}`, method, params }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchEager((error) =>
        Effect.logDebug("Herdr report failed").pipe(Effect.annotateLogs({ error: String(error) })),
      ),
    )
  })

  const worker = yield* Effect.forever(
    Effect.gen(function* () {
      const snapshot = yield* Queue.take(reports)
      yield* send("pane.report_agent", snapshot)
    }),
  ).pipe(Effect.forkScoped)

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true
      yield* Fiber.interrupt(worker)
      yield* Queue.shutdown(reports)
      yield* send("pane.release_agent")
    }),
  )

  return {
    report: (snapshot: ClientActivitySnapshot): void => {
      if (closed) return
      const key = `${snapshot.sessionId ?? ""}:${snapshot.state}`
      if (key === previous) return
      previous = key
      Queue.offerUnsafe(reports, snapshot)
    },
  }
})

// ── herdr extension ─────────────────────────────────────────────────────────

/** Herdr lifecycle integration. Inactive outside an identified Herdr pane. */

export const builtinHerdr = defineClientExtension("@gent/herdr", {
  setup: Effect.gen(function* () {
    const target = yield* herdrEnvironment.pipe(Effect.orDie)
    if (Option.isNone(target)) return clientContributions()
    const activity = yield* ClientActivity
    const read = activity.snapshot
    const lifecycle = yield* ClientLifecycle
    const reporter = yield* lifecycle.scoped(makeHerdrReporter(target.value))
    createRoot((dispose) => {
      createEffect(() => reporter.report(read()))
      lifecycle.addCleanup(dispose)
    })
    return clientContributions()
  }),
})

// ── driver extension ────────────────────────────────────────────────────────

/**
 * Driver routing UI — `/driver` slash command.
 *
 *   - `/driver <agent> <driverId>`    → set per-agent runtime override
 *   - `/driver <agent> default|clear` → remove the override
 *   - `/driver` (no args)             → usage hint
 *
 * Validation lives server-side: `driver.set` rejects unknown driver ids. The
 * usage hint and every failure go to the footer through `ClientShell.notify`;
 * a change that lands reports nothing.
 *
 * This contribution is delivered by a core builtin (not by the
 * `@gent/acp-agents` extension) so the slash remains available even when
 * the ACP extension is disabled — useful for clearing a stale override.
 */

const USAGE = "Usage: /driver <agent> <driver-id|default>"

const driverRef = (entry: { readonly _tag: string; readonly id: string }) => {
  if (entry._tag === "External") return ExternalDriverRef.make({ id: entry.id })
  return ModelDriverRef.make({ id: entry.id })
}

export const builtinDriver = defineClientExtension("@gent/driver-ui", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    const transport = yield* ClientTransport
    const notify = (message: string) => Effect.sync(() => shell.notify(message))

    const clearDriver = (agentName: AgentName) =>
      transport
        .driverClear({ agentName })
        .pipe(Effect.catch((error) => notify(`Failed to clear driver override: ${String(error)}`)))

    const setDriver = (agentName: AgentName, driverId: string) =>
      Effect.gen(function* () {
        const { drivers } = yield* transport.driverList
        const matches = drivers.filter((driver) => driver.id === driverId)
        const match = Option.fromNullishOr(matches[0])
        if (matches.length > 1) return yield* notify(`Ambiguous driver "${driverId}".`)
        if (Option.isNone(match)) return yield* notify(`Unknown driver "${driverId}".`)
        yield* transport.driverSet({ agentName, driver: driverRef(match.value) })
      }).pipe(Effect.catch((error) => notify(`Failed to set driver: ${String(error)}`)))

    const route = (args: string): Effect.Effect<void> => {
      const parts = args.trim().split(/\s+/)
      const rawAgentName = Option.fromNullishOr(parts[0])
      const driverArg = Option.fromNullishOr(parts[1])
      if (parts.length !== 2 || Option.isNone(rawAgentName) || Option.isNone(driverArg)) {
        return notify(USAGE)
      }
      const agentName = AgentName.make(rawAgentName.value)
      if (driverArg.value === "default" || driverArg.value === "clear") {
        return clearDriver(agentName)
      }
      return setDriver(agentName, driverArg.value)
    }

    return clientCommandContribution({
      id: "driver.route",
      title: "Driver routing",
      description: "Set or clear a per-agent driver override",
      category: "Driver",
      slash: "driver",
      onSelect: () => shell.notify(USAGE),
      onSlash: (args) => shell.cast(route(args)),
    })
  }),
})

// ── goal extension ──────────────────────────────────────────────────────────

/**
 * Goal status label — transport-only.
 *
 * Reads the branch goal through `GoalRpc.Get` and refreshes on
 * `ExtensionStateChanged` pulses for `@gent/goal`. Renders one bottom-right
 * border label while a goal is pending on the current branch, and collapses
 * each goal continuation message to one line.
 */

const builtinGoal = defineClientExtension(GOAL_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const lifecycle = yield* ClientLifecycle

    const snapshot = yield* sessionQuery({
      initial: Option.none<GoalSnapshot>(),
      follow: true,
      fetch: (session) => transport.request(ref(GoalRpc.Get), {}, session).pipe(Effect.asSome),
    })
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId === GOAL_EXTENSION_ID) snapshot.refresh()
      }),
    )

    return clientContributions(
      messageRendererContribution(GOAL_CONTEXT_MESSAGE_TYPE, () => (
        <CollapsedRow label="↻ goal continuation" />
      )),
      borderLabelContribution({
        position: "bottom-right",
        priority: 40,
        produce: () => {
          const goal = snapshot.value().pipe(
            Option.flatMap((value) => Option.fromUndefinedOr(value.goal)),
            Option.filter((value) => value.status !== "complete"),
          )
          if (Option.isNone(goal)) return []
          const parts = [`goal ${goal.value.status}`, `${goal.value.continuationsUsed}↻`]
          Option.map(remainingTokens(goal.value), (remaining) => {
            parts.push(`${remaining} left`)
          })
          let color: "info" | "warning" = "info"
          if (goal.value.status !== "active") color = "warning"
          return [{ text: parts.join(" · "), color }]
        },
      }),
    )
  }),
})

// ── session message row ─────────────────────────────────────────────────────

/** A message from another session names its sender on a line of its own. */
const decodeSessionMessageDetails = Schema.decodeUnknownOption(SessionMessageDetails)

/** The sender line fits the id: an auto-named child carries its whole task in the name. */
const SENDER_NAME_MAX_COLUMNS = 32

const graphemes = new Intl.Segmenter([], { granularity: "grapheme" })

/** Cuts by terminal columns and whole graphemes, so a wide or combined character is never split. */
const shortName = (name: string): string => {
  const flat = name.replace(/\s+/g, " ").trim()
  if (textWidth(flat) <= SENDER_NAME_MAX_COLUMNS) return flat
  let kept = ""
  for (const { segment } of graphemes.segment(flat)) {
    if (textWidth(kept + segment) > SENDER_NAME_MAX_COLUMNS - 1) break
    kept += segment
  }
  return `${kept.trimEnd()}…`
}

/** Who wrote a sent message: the relation, the cut name, and the short session id. */
const senderLine = ({ from }: SessionMessageDetails): string => {
  const who = Option.liftPredicate(from.relation, (relation) => relation !== "session").pipe(
    Option.map((relation) => `your ${relation}`),
    Option.getOrElse(() => "session"),
  )
  const name = Option.fromUndefinedOr(from.name).pipe(
    Option.map((value) => ` "${shortName(value)}"`),
    Option.getOrElse(() => ""),
  )
  return `» from ${who}${name} · ${from.sessionId.slice(0, 8)}`
}

/**
 * The model reads the header `sessionMessageText` writes, then the text. The
 * row puts the sender in its own muted line and `sessionMessageBody` removes
 * the header, old rows included, so blank lines in a name or body stay whole.
 * Details that do not decode draw the plain row.
 */
const builtinSessionMessages = defineClientExtension(SESSION_TOOLS_EXTENSION_ID, {
  setup: Effect.succeed(
    messageRendererContribution(SESSION_MESSAGE_TYPE, (props) => (
      <Show
        when={Option.getOrUndefined(decodeSessionMessageDetails(props.details))}
        fallback={<UserRow {...props} />}
      >
        {(details) => (
          <UserRow
            {...props}
            header={senderLine(details())}
            content={sessionMessageBody(details().from, props.content)}
          />
        )}
      </Show>
    )),
  ),
})

// ── connection widget ───────────────────────────────────────────────────────

export function ConnectionWidget() {
  const client = useClient()
  const ext = useExtensionUI()
  const { theme } = useTheme()
  const disconnectedReason = () => {
    const state = Option.fromNullishOr(client.connectionState())
    if (Option.isNone(state)) return Option.none<string>()
    if (state.value._tag !== "Disconnected" || state.value.reason === "stopped") {
      return Option.none<string>()
    }
    return Option.some(state.value.reason)
  }
  const connectionIssue = () => Option.fromNullishOr(client.connectionIssue())
  const degradedExtensions = () => {
    const health = client.extensionHealth()
    if (health._tag === "Degraded") return health.degradedExtensions
    return []
  }
  const failedExtensions = () => [
    ...degradedExtensions()
      .filter((extension) => extension.issues.some((issue) => issue._tag === "ActivationFailed"))
      .map((extension) => extension.manifest.id),
    ...ext.failures().map((failure) => failure.id),
  ]
  const hasFailedExtensions = () => failedExtensions().length > 0
  // Reconnecting and the restart count belong to the top-left border label;
  // this widget draws what the label cannot: issues and failed extensions.
  const visible = () =>
    Option.isSome(connectionIssue()) || Option.isSome(disconnectedReason()) || hasFailedExtensions()
  const accent = () => {
    if (hasFailedExtensions()) return theme.warning
    return theme.error
  }
  const subtitle = () => {
    if (hasFailedExtensions()) return "extension activation degraded"
    if (Option.isSome(disconnectedReason())) return "runtime unavailable"
    return Option.getOrElse(connectionIssue(), () => "")
  }
  return (
    <Show when={visible()}>
      <box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1}>
        <text>
          <span style={{ fg: accent(), bold: true }}>• connection</span>
          <span style={{ fg: theme.textMuted }}> · {subtitle()}</span>
        </text>
        <box flexDirection="column" paddingLeft={2}>
          <Show when={Option.isSome(connectionIssue())}>
            <text>
              <span style={{ fg: theme.text }}>{Option.getOrUndefined(connectionIssue())}</span>
            </text>
          </Show>
          <Show when={Option.isSome(disconnectedReason())}>
            <text>
              <span style={{ fg: theme.text }}>{Option.getOrUndefined(disconnectedReason())}</span>
            </text>
          </Show>
          <Show when={hasFailedExtensions()}>
            <text>
              <span style={{ fg: theme.text }}>
                failed extensions: {failedExtensions().join(", ")}
              </span>
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

// ── tool renderer extensions ────────────────────────────────────────────────

/**
 * Builtin tool and interaction renderers for the TUI.
 */

const builtinTools = defineClientExtension("@gent/tools", {
  setup: Effect.succeed(
    clientContributions(
      ...BUILTIN_TOOL_RENDERERS.map((entry) =>
        rendererContribution(entry.toolNames, entry.component),
      ),
    ),
  ),
})

const builtinInteractions = defineClientExtension("@gent/interaction-tools", {
  setup: Effect.succeed(
    clientContributions(
      interactionRendererContribution(PromptRenderer),
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, "ask-user"),
      interactionRendererContribution(HandoffRenderer, "handoff"),
    ),
  ),
})

// ── builtin module registry ─────────────────────────────────────────────────

const builtinConnection = defineClientExtension("@gent/connection", {
  setup: Effect.succeed(
    widgetContribution({
      id: "connection",
      slot: "below-messages",
      priority: 30,
      component: ConnectionWidget,
    }),
  ),
})

const builtinSkills = defineClientExtension("@gent/skills-ui", {
  setup: Effect.gen(function* () {
    const workspace = yield* ClientWorkspace
    // The store's reads and writes need `FileSystem` and `Path`. `onSelect`
    // is a plain sync callback from the composer with no Effect context of
    // its own, so the setup captures the services once and forks the write
    // against them.
    const storeServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const forkStoreWrite = Effect.runForkWith(storeServices)
    return autocompleteContribution({
      prefix: "$",
      title: "Skills",
      // Skills were filtered by a plain substring test and left in whatever
      // order the host returned them, so `$te` answered with the first skill
      // whose name happened to contain those letters rather than the closest
      // one. Ranking puts the nearest name first, which is also the completion
      // the composer's ghost line offers.
      // The store is read from disk per request rather than from the shared
      // in-memory snapshot. This runs in an extension setup's Effect, which
      // may await, and the file is a few KB opened on a keystroke, so the read
      // is cheap and picks written by another `gent` process are seen too.
      items: (filter: string) =>
        Effect.gen(function* () {
          const transport = yield* ClientTransport
          const skills = yield* transport.request(ref(SkillsRpc.ListSkills), {})
          const store = yield* readFrecencyStore(workspace.home)
          const lookup = frecencyLookup(
            Option.getOrElse(store, () => emptyFrecencyStore()),
            yield* Clock.currentTimeMillis,
          )
          return rankAutocompleteItems(
            skills.map((s) => ({
              id: s.name,
              label: s.name,
              description: truncate(s.description, 60),
            })),
            filter,
            { prefix: "$", frecency: lookup },
          )
        }),
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
      // Recording happens here rather than at the composer seam for `$`
      // alone, because the skills popup is the only surface that knows a
      // chosen row was a skill. The write itself belongs to the store, which
      // folds the pick into what is on disk under one gate — the `/` registry
      // records through the same function. Two writers with two strategies is
      // exactly what used to lose picks.
      onSelect: (id: string) => {
        forkStoreWrite(
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            recordFrecencyPick(workspace.home, "$", id, now),
          ),
        )
      },
    })
  }),
})

// Builtins keep their precise `R` locally; the load membrane erases them in
// one place when `loader-boundary.ts` runs `runtime.runPromise(...)`.
export const builtinClientModules: ReadonlyArray<AnyExtensionClientModule> = [
  builtinAgentsView,
  builtinBtw,
  builtinConnection,
  builtinDriver,
  builtinFiles,
  builtinGoal,
  builtinWake,
  builtinHerdr,
  builtinInteractions,
  builtinSessionMessages,
  builtinSkills,
  builtinThreadView,
  builtinTools,
]
