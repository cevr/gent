/**
 * A fake GitHub and git on the process boundary, for the integration gate:
 * `gh auth status`, the `gh api` reads the gate makes, and the `git` verbs
 * it runs. Every run is returned for any commit, so the gate must filter
 * by `head_sha`.
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

export interface Run {
  readonly name: string
  readonly head_sha: string
  readonly status: "queued" | "in_progress" | "completed"
  /** None while the run is not completed. */
  readonly conclusion?: string
}

export interface Remote {
  head: string
  gh: "ready" | "missing" | "signed-out"
  /** Contexts branch protection requires; none: protection cannot be read. */
  required: Option.Option<ReadonlyArray<string>>
  /** Every run the fake knows, returned for any commit: the gate must filter by `head_sha`. */
  runs: Array<Run & { readonly id: number }>
  apiFails: boolean
  /** Every head that does not descend from the remote head. */
  diverged: Set<string>
  pushes: Array<string>
  /** Held while set: the push waits for it. */
  pushGate: Option.Option<Deferred.Deferred<void>>
  pushStarted: Option.Option<Deferred.Deferred<void>>
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
})
const encodeCheckRuns = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ check_runs: Schema.Array(CheckRunWire) })),
)
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
      head: BASE,
      gh: "ready",
      required: Option.some(["test"]),
      runs: [],
      apiFails: false,
      diverged: new Set(),
      pushes: [],
      pushGate: Option.none(),
      pushStarted: Option.none(),
      ...initial,
    }
    let nextId = 1
    const addRun = (run: Run) => {
      remote.runs.push({ ...run, id: nextId++ })
    }
    const api = (path: string) => {
      if (remote.apiFails) return answer(1, "", "HTTP 502: Bad Gateway")
      if (path === `repos/${REPO}/git/ref/heads/main`) {
        return answer(0, encodeJson({ object: { sha: remote.head } }))
      }
      if (path === `repos/${REPO}/branches/main/protection/required_status_checks`) {
        return Option.match(remote.required, {
          onNone: () => answer(1, "", "HTTP 404: Branch not protected"),
          onSome: (contexts) => answer(0, encodeJson({ contexts, checks: [] })),
        })
      }
      if (path === `repos/${REPO}/rules/branches/main`) return answer(0, "[]")
      if (/^repos\/cevr\/gent\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) {
        const runs = remote.runs.map((run) => ({
          ...run,
          conclusion: Option.fromUndefinedOr(run.conclusion),
        }))
        return answer(0, encodeCheckRuns({ check_runs: runs }))
      }
      const status = /^repos\/cevr\/gent\/commits\/([0-9a-f]{40})\/status$/.exec(path)
      if (Predicate.isNotNull(status)) {
        return answer(0, encodeJson({ sha: status[1], statuses: [] }))
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
      if (args[0] !== "auth") return api(args[1] ?? "")
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
          return answer(0, `git@github.com:${REPO}.git\n`)
        case "rev-parse --verify": {
          const spec = (args[2] ?? "").replace("^{commit}", "")
          if (spec === "HEAD") return answer(0, `${CANDIDATE}\n`)
          return answer(0, `${spec}\n`)
        }
        case "merge-base --is-ancestor":
          if (remote.diverged.has(args[3] ?? "")) return answer(1)
          return answer(0)
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
      layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    }
  })
