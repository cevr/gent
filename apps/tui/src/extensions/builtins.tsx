import { FileFinder } from "@ff-labs/fff-bun"
import {
  Clock,
  FileSystem,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  type Path,
  Queue,
  Schema,
} from "effect"
import {
  type AnyExtensionClientModule,
  AskUserRenderer,
  autocompleteContribution,
  BUILTIN_TOOL_RENDERERS,
  type ClientActivitySnapshot,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  CollapsedRow,
  defineClientExtension,
  formatFileRef,
  HandoffRenderer,
  interactionRendererContribution,
  isReferenceablePath,
  messageRendererContribution,
  PromptRenderer,
  rankAutocompleteItems,
  readFrecencyLookup,
  recordFrecencyPick,
  rendererContribution,
  sessionQuery,
  shortId,
  statusLabelContribution,
  textWidth,
  truncate,
  truncatePath,
  UserRow,
} from "@gent/tui/extensions"
import { BunSocket } from "@effect/platform-bun"
import { createEffect, createRoot, Show } from "solid-js"
import { AgentName, DriverRef } from "@gent/core/protocol"
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
  FilesRpc,
  SkillsRpc,
} from "@gent/extensions/client"
import builtinAgentsView from "./agents.client"
import builtinBtw from "./btw.client"
import builtinDelegate from "./delegate.client"
import builtinWake from "./wake.client"
import builtinThreadView from "./thread-view.client"

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
 * fff ranks the `@` popup: fuzzy distance, filename hits, and its own
 * frecency of which files this reader picks for which query. It scans the
 * session's directory once per directory and keeps its databases under
 * `~/.gent/fff`.
 *
 * fff honors `.gitignore` but not every exclude rule the model's own listing
 * does (an exclude above its root, `.git/info/exclude`), so it only ranks:
 * the popup keeps the paths `FilesRpc.List` names, the files the model can
 * search, and pages through fff's ranking until it holds a full page of them.
 */

class FileFinderUnavailableError extends Schema.TaggedError<FileFinderUnavailableError>()(
  "FileFinderUnavailableError",
  {},
) {}

class FileFinderError extends Schema.TaggedError<FileFinderError>()("FileFinderError", {
  reason: Schema.String,
}) {}

/** The fff page the popup reads at a time while it filters to listed paths. */
const FINDER_PAGE_SIZE = 200

/** One finder per scanned directory, and the scan it started. */
interface FinderEntry {
  readonly finder: FileFinder
  readonly scanned: Effect.Effect<void, FileFinderError>
}

const createFinder = (cwd: string, dbDir: string) =>
  Effect.gen(function* () {
    if (!FileFinder.isAvailable()) return yield* new FileFinderUnavailableError()
    const created = FileFinder.create({
      basePath: cwd,
      frecencyDbPath: `${dbDir}/frecency.mdb`,
      historyDbPath: `${dbDir}/history.mdb`,
      aiMode: true,
      // The popup matches names only: no content cache, no content index.
      disableMmapCache: true,
      disableContentIndexing: true,
    })
    if (!created.ok) return yield* new FileFinderError({ reason: String(created.error) })
    const finder = created.value
    const scanned = yield* Effect.cached(
      Effect.tryPromise({
        try: () => finder.waitForScan(15_000),
        catch: (cause) => new FileFinderError({ reason: String(cause) }),
      }).pipe(
        Effect.flatMap((scan) => {
          if (scan.ok) return Effect.void
          return Effect.fail(new FileFinderError({ reason: String(scan.error) }))
        }),
      ),
    )
    return { finder, scanned } satisfies FinderEntry
  })

/**
 * fff's ranking for `query`, kept to the `listed` paths, up to `limit`. The
 * pages stop at the end of fff's matches.
 */
const rankListed = (
  entry: FinderEntry,
  query: string,
  listed: ReadonlySet<string>,
  limit: number,
) =>
  Effect.gen(function* () {
    yield* entry.scanned
    const kept: Array<string> = []
    for (let pageIndex = 0; kept.length < limit; pageIndex++) {
      const page = entry.finder.fileSearch(query, { pageIndex, pageSize: FINDER_PAGE_SIZE })
      if (!page.ok) return yield* new FileFinderError({ reason: String(page.error) })
      for (const item of page.value.items) {
        if (!listed.has(item.relativePath)) continue
        kept.push(item.relativePath)
        if (kept.length >= limit) break
      }
      const seen = (pageIndex + 1) * FINDER_PAGE_SIZE
      if (page.value.items.length < FINDER_PAGE_SIZE || seen >= page.value.totalMatched) break
    }
    return kept
  })

// ── files extension ─────────────────────────────────────────────────────────

/**
 * Files autocomplete (`@`). The paths are fs-tools' own listing through
 * `FilesRpc.List`, so the files a user can name are the files the model can
 * search: git's listing inside a work tree, the `.gitignore` walk outside one.
 * fff ranks them and keeps the pick history. Where fff cannot run, the shared
 * matcher ranks the listing instead.
 *
 * The list is read when the popup opens (an empty filter) and reused for each
 * keystroke after, so typing does not relist the tree. A path is written as
 * the composer reads it back (`formatFileRef`), and a directory row completes
 * to `@dir/` so the popup keeps going inside it.
 */

const MAX_RESULTS = 50

const formatMatch = (path: string) => {
  const isDirectory = path.endsWith("/")
  const segments = path.split("/").filter((segment) => segment.length > 0)
  const segment = Option.getOrElse(Option.fromUndefinedOr(segments.at(-1)), () => path)
  let name = segment
  if (isDirectory) name = `${segment}/`
  const tag = getFileTag(path)
  let label = name
  if (tag.length > 0 && !isDirectory) label = `${tag} ${name}`
  return {
    id: path,
    label,
    description: truncatePath(path, 40),
  }
}

/** The listing's top level: each first path segment once, a directory with its slash. */
const topLevel = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const entries = new Set<string>()
  for (const path of paths) {
    const slash = path.indexOf("/")
    let entry = path
    if (slash !== -1) entry = path.slice(0, slash + 1)
    entries.add(entry)
  }
  return [...entries].toSorted()
}

export const builtinFiles = defineClientExtension("@gent/files-ui", {
  setup: Effect.gen(function* () {
    const { workspace, transport, lifecycle } = yield* ClientContext
    const dbDir = `${workspace.home}/.gent/fff`
    const finders = new Map<string, FinderEntry>()
    lifecycle.addCleanup(() => {
      for (const entry of finders.values()) entry.finder.destroy()
      finders.clear()
    })
    const finderFor = Effect.fn("FilesPopup.finderFor")(function* (cwd: string) {
      const existing = Option.fromUndefinedOr(finders.get(cwd))
      if (Option.isSome(existing)) return existing.value
      const fs = yield* FileSystem.FileSystem
      yield* Effect.ignore(fs.makeDirectory(dbDir, { recursive: true }))
      const entry = yield* createFinder(cwd, dbDir)
      finders.set(cwd, entry)
      return entry
    })
    // The directory the last ranking used, for recording the pick against it.
    let rankedIn = Option.none<string>()
    let listing = Option.none<ReadonlyArray<string>>()
    // One read at a time: keys typed while a listing is on its way wait for it.
    let pending = Option.none<Fiber.Fiber<ReadonlyArray<string>>>()
    const fetchListing = transport.request(ref(FilesRpc.List), {}).pipe(
      Effect.map((paths) => paths.filter(isReferenceablePath)),
      // A failed listing offers nothing until the popup opens again.
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.tap((paths) =>
        Effect.sync(() => {
          listing = Option.some(paths)
        }),
      ),
    )
    const readListing = Effect.gen(function* () {
      if (Option.isSome(pending)) return yield* Fiber.join(pending.value)
      const fiber = yield* lifecycle.scoped(Effect.forkScoped(fetchListing))
      pending = Option.some(fiber)
      return yield* Fiber.join(fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (Option.contains(pending, fiber)) pending = Option.none()
          }),
        ),
      )
    })
    return autocompleteContribution({
      prefix: "@",
      title: "Files",
      items: (filter: string) =>
        Effect.gen(function* () {
          const cwd = yield* workspace.sessionCwd
          if (filter.length === 0) {
            const paths = yield* readListing
            // Opening the popup starts the scan, so the first typed key finds it ready.
            yield* lifecycle.scoped(Effect.forkScoped(Effect.ignore(finderFor(cwd))))
            return topLevel(paths).slice(0, MAX_RESULTS).map(formatMatch)
          }
          const paths = yield* Option.match(listing, {
            onNone: () => readListing,
            onSome: Effect.succeed,
          })
          const ranked = yield* finderFor(cwd).pipe(
            Effect.flatMap((entry) => rankListed(entry, filter, new Set(paths), MAX_RESULTS)),
            Effect.tap(() =>
              Effect.sync(() => {
                rankedIn = Option.some(cwd)
              }),
            ),
            Effect.orElseSucceed(() =>
              rankAutocompleteItems(
                paths.map((path) => ({ id: path, label: path })),
                filter,
                { prefix: "@" },
              )
                .slice(0, MAX_RESULTS)
                .map((item) => item.id),
            ),
          )
          return ranked.map(formatMatch)
        }),
      formatInsertion: (id: string) => {
        // A directory keeps completing inside itself; a file ends the reference.
        if (id.endsWith("/")) return formatFileRef(id)
        return `${formatFileRef(id)} `
      },
      onSelect: (id: string, filter: string) => {
        if (id.endsWith("/")) return
        const entry = Option.flatMap(rankedIn, (cwd) => Option.fromUndefinedOr(finders.get(cwd)))
        if (Option.isSome(entry)) entry.value.finder.trackQuery(filter, id)
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
    const { activity, lifecycle } = yield* ClientContext
    const read = activity.snapshot
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
 * usage hint and every failure go to the footer through `shell.notify`;
 * a change that lands reports nothing.
 */

const USAGE = "Usage: /driver <agent> <driver-id|default>"

export const builtinDriver = defineClientExtension("@gent/driver-ui", {
  setup: Effect.gen(function* () {
    const { shell, transport } = yield* ClientContext
    const notify = (message: string) => Effect.sync(() => shell.notify(message))

    const clearDriver = (agentName: AgentName) =>
      transport
        .driverClear({ agentName })
        .pipe(Effect.catch((error) => notify(`Failed to clear driver override: ${String(error)}`)))

    const setDriver = (agentName: AgentName, driverId: string) =>
      Effect.gen(function* () {
        const { drivers } = yield* transport.driverList
        if (!drivers.some((driver) => driver.id === driverId)) {
          return yield* notify(`Unknown driver "${driverId}".`)
        }
        yield* transport.driverSet({ agentName, driver: DriverRef.make({ id: driverId }) })
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
 * `ExtensionStateChanged` pulses for `@gent/goal`. Renders one
 * status label while a goal is pending on the current branch, and collapses
 * each goal continuation message to one line.
 */

const builtinGoal = defineClientExtension(GOAL_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle } = yield* ClientContext

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
      statusLabelContribution({
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
  return `» from ${who}${name} · ${shortId(from.sessionId)}`
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
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, "ask-user"),
      interactionRendererContribution(HandoffRenderer, "handoff"),
    ),
  ),
})

// ── builtin module registry ─────────────────────────────────────────────────

const builtinSkills = defineClientExtension("@gent/skills-ui", {
  setup: Effect.gen(function* () {
    const { workspace } = yield* ClientContext
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
          const { transport } = yield* ClientContext
          const skills = yield* transport.request(ref(SkillsRpc.ListSkills), {})
          const lookup = yield* readFrecencyLookup(workspace.home)
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
  builtinDelegate,
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
