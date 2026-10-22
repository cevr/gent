/**
 * A fake GitHub and git on the process boundary, for the integration gate:
 * `gh auth status`, the `gh api` reads the gate makes, and the `git` verbs
 * it runs. Every run is returned for any commit, so the gate must filter
 * by `head_sha`. A list answers in pages of `pageSize`: page 1 alone, or,
 * with `--paginate --slurp`, one array of every page.
 */
import {
  Deferred,
  Effect,
  Layer,
  Option,
  PlatformError,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"

export const REPO = "cevr/gent"
export const KEY = { repo: REPO, ref: "main" }
const shaOf = (digit: string) => digit.repeat(40)
export const BASE = shaOf("a")
export const CANDIDATE = shaOf("b")
export const FIX = shaOf("c")
export const OUTSIDE = shaOf("d")
/** The GitHub Actions app: the source of a run that names no other. */
export const ACTIONS_APP = 15368

/** A context branch protection requires, pinned to an app when `appId` is set. */
export interface Required {
  readonly context: string
  readonly appId?: number
}

export interface Run {
  readonly name: string
  readonly head_sha: string
  readonly status: "queued" | "in_progress" | "completed"
  /** None while the run is not completed. */
  readonly conclusion?: string
  /** The app that reported the run; the Actions app when absent. */
  readonly appId?: number
}

/** A commit status: it names no app. */
interface Status {
  readonly context: string
  readonly sha: string
  readonly state: "pending" | "success" | "failure" | "error"
}

export interface Remote {
  /** The URL `git remote get-url` answers; none: the remote does not exist. */
  url: Option.Option<string>
  head: string
  gh: "ready" | "missing" | "signed-out"
  /** Contexts branch protection requires; none: protection cannot be read. */
  required: Option.Option<ReadonlyArray<Required>>
  /** Every run the fake knows, returned for any commit: the gate must filter by `head_sha`. */
  runs: Array<Run & { readonly id: number }>
  statuses: Array<Status>
  /** The entries of one page of a list. */
  pageSize: number
  apiFails: boolean
  /** The protection read alone answers a server error. */
  protectionFails: boolean
  /** Every head that does not descend from the remote head. */
  diverged: Set<string>
  pushes: Array<string>
  /** Held while set: the push waits for it. */
  pushGate: Option.Option<Deferred.Deferred<void>>
  pushStarted: Option.Option<Deferred.Deferred<void>>
  /** Runs as the gate asks whether the commit fast-forwards: after admission read the record. */
  onAncestry: Option.Option<Effect.Effect<void>>
}

// ── the wire ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

/** GitHub's check run: `conclusion` is null until the run completes. */
const CheckRunWire = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  head_sha: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
  app: Schema.Struct({ id: Schema.Finite }),
})
const CheckRunsPage = Schema.Struct({ check_runs: Schema.Array(CheckRunWire) })
const encodeCheckRuns = Schema.encodeSync(Schema.fromJsonString(CheckRunsPage))
const encodeCheckRunPages = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CheckRunsPage)))
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/** The text as one chunk, or no chunk for none. */
const streamOf = (text: string) =>
  Stream.make(encoder.encode(text)).pipe(Stream.filter((chunk) => chunk.length > 0))

const answer = (
  exit: number,
  stdout = "",
  stderr = "",
): Effect.Effect<ChildProcessSpawner.ChildProcessHandle> =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: streamOf(stdout),
      stderr: streamOf(stderr),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  )

const unexpected = (command: string, args: ReadonlyArray<string>) =>
  Effect.die(`unexpected command ${command} ${args.join(" ")}`)

// ── the fake ────────────────────────────────────────────────────────────────

export const fakeGitHub = (initial: Partial<Remote> = {}) =>
  Effect.sync(() => {
    const remote: Remote = {
      url: Option.some(`git@github.com:${REPO}.git`),
      head: BASE,
      gh: "ready",
      required: Option.some([{ context: "test" }]),
      runs: [],
      statuses: [],
      pageSize: 100,
      apiFails: false,
      protectionFails: false,
      diverged: new Set(),
      pushes: [],
      pushGate: Option.none(),
      pushStarted: Option.none(),
      onAncestry: Option.none(),
      ...initial,
    }
    let nextId = 1
    const addRun = (run: Run) => {
      remote.runs.push({ ...run, id: nextId++ })
    }
    const addStatus = (status: Status) => {
      remote.statuses.push(status)
    }
    /** The pages of a list: at least one, so an empty list answers one empty page. */
    const pagesOf = <A>(entries: ReadonlyArray<A>): Array<ReadonlyArray<A>> => {
      const pages: Array<ReadonlyArray<A>> = []
      for (let start = 0; start < entries.length; start += remote.pageSize) {
        pages.push(entries.slice(start, start + remote.pageSize))
      }
      if (pages.length === 0) return [[]]
      return pages
    }
    const api = (path: string, slurp: boolean) => {
      if (remote.apiFails) return answer(1, "", "HTTP 502: Bad Gateway")
      if (path === `repos/${REPO}/git/ref/heads/main`) {
        return answer(0, encodeJson({ object: { sha: remote.head } }))
      }
      if (path === `repos/${REPO}/branches/main/protection/required_status_checks`) {
        if (remote.protectionFails) return answer(1, "", "HTTP 503: Service Unavailable")
        return Option.match(remote.required, {
          onNone: () => answer(1, "", "HTTP 404: Branch not protected"),
          onSome: (required) =>
            answer(
              0,
              encodeJson({
                contexts: required.map((check) => check.context),
                checks: required.map((check) => ({
                  context: check.context,
                  // oxlint-disable-next-line effect/noNullish -- GitHub's wire shape: a null app_id accepts any source
                  app_id: check.appId ?? null,
                })),
              }),
            ),
        })
      }
      if (path === `repos/${REPO}/rules/branches/main`) return answer(0, "[]")
      if (/^repos\/cevr\/gent\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) {
        const runs = remote.runs.map((run) => ({
          id: run.id,
          name: run.name,
          head_sha: run.head_sha,
          status: run.status,
          conclusion: Option.fromUndefinedOr(run.conclusion),
          app: { id: run.appId ?? ACTIONS_APP },
        }))
        const pages = pagesOf(runs).map((page) => ({ check_runs: page }))
        if (slurp) return answer(0, encodeCheckRunPages(pages))
        return answer(0, encodeCheckRuns(pages[0] ?? { check_runs: [] }))
      }
      const status = /^repos\/cevr\/gent\/commits\/([0-9a-f]{40})\/status(?:\?|$)/.exec(path)
      if (Predicate.isNotNull(status)) {
        const sha = status[1]
        const statuses = remote.statuses
          .filter((entry) => entry.sha === sha)
          .map((entry) => ({ context: entry.context, state: entry.state }))
        const pages = pagesOf(statuses).map((page) => ({ sha, statuses: page }))
        if (slurp) return answer(0, encodeJson(pages))
        return answer(0, encodeJson(pages[0]))
      }
      return answer(1, "", `HTTP 404: ${path}`)
    }
    const gh = (args: ReadonlyArray<string>) => {
      if (remote.gh === "missing") {
        return Effect.fail(
          // oxlint-disable-next-line effect/preferTaggedConstructors -- `_tag` is the reason option systemError takes, not a tagged value
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        )
      }
      if (args[0] !== "auth") {
        return api(args[1] ?? "", args.includes("--paginate") && args.includes("--slurp"))
      }
      if (remote.gh === "ready") return answer(0, "Logged in to github.com")
      return answer(1, "", "You are not logged into any GitHub hosts")
    }
    const push = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* Option.match(remote.pushStarted, {
          onNone: () => Effect.void,
          onSome: (started) => Deferred.succeed(started, void 0),
        })
        yield* Option.match(remote.pushGate, {
          onNone: () => Effect.void,
          onSome: Deferred.await,
        })
        const sha = (args[2] ?? "").split(":")[0] ?? ""
        remote.pushes.push(sha)
        remote.head = sha
        return yield* answer(0)
      })
    const git = (args: ReadonlyArray<string>) => {
      const verb = `${args[0] ?? ""} ${args[1] ?? ""}`
      switch (verb) {
        case "remote get-url":
          return Option.match(remote.url, {
            onNone: () => answer(2, "", `error: No such remote '${args[2] ?? ""}'\n`),
            onSome: (url) => answer(0, `${url}\n`),
          })
        case "rev-parse --verify": {
          const spec = (args[2] ?? "").replace("^{commit}", "")
          if (spec === "HEAD") return answer(0, `${CANDIDATE}\n`)
          return answer(0, `${spec}\n`)
        }
        case "merge-base --is-ancestor": {
          const hook = Option.getOrElse(remote.onAncestry, () => Effect.void)
          if (remote.diverged.has(args[3] ?? "")) return Effect.andThen(hook, answer(1))
          return Effect.andThen(hook, answer(0))
        }
      }
      if (args[0] === "push") return push(args)
      return unexpected("git", args)
    }
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("piped command")
      if (command.command === "gh") return gh(command.args)
      if (command.command === "git") return git(command.args)
      return unexpected(command.command, command.args)
    })
    return {
      remote,
      addRun,
      addStatus,
      layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      /** The fake for `gh` and `git`; any other command spawns on the spawner it is given. */
      layerOverReal: Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (real) =>
          ChildProcessSpawner.make((command) => {
            const owned =
              command._tag === "StandardCommand" &&
              (command.command === "gh" || command.command === "git")
            if (owned) return spawner.spawn(command)
            return real.spawn(command)
          }),
        ),
      ),
    }
  })
