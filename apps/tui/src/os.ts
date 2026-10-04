import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Schema,
  Semaphore,
} from "effect"
import { GentPlatform } from "@gent/core/host"
import { runProcess } from "@gent/core/extensions/api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createContext } from "solid-js"
import { useRequiredContext } from "./utils"

// ── link opening ────────────────────────────────────────────────────────────

export class LinkOpenerError extends Schema.TaggedError<LinkOpenerError>()("LinkOpenerError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface LinkOpenerService {
  readonly open: (
    url: string,
  ) => Effect.Effect<void, LinkOpenerError, ChildProcessSpawner.ChildProcessSpawner>
}

const makeOpener = (command: string, argsForUrl: (url: string) => string[]): LinkOpenerService => ({
  open: Effect.fn("LinkOpener.open")((url: string) =>
    runProcess(command, argsForUrl(url), { stdout: "ignore", stderr: "pipe" }).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) return Effect.void
        return Effect.fail(
          new LinkOpenerError({
            message: `Failed to open URL: ${url}: ${result.stderr || `Exit code ${result.exitCode}`}`,
          }),
        )
      }),
      Effect.catchTag("ProcessError", (e) =>
        Effect.fail(
          new LinkOpenerError({
            message: `Failed to open URL: ${url}`,
            cause: e,
          }),
        ),
      ),
    ),
  ),
})

/** The command that opens a URL on the platform, when the platform has one. */
const openerFor = (platform: string): LinkOpenerService => {
  if (platform === "darwin") return makeOpener("open", (url) => [url])
  if (platform === "win32") return makeOpener("cmd", (url) => ["/c", "start", "", url])
  if (platform === "linux") return makeOpener("xdg-open", (url) => [url])
  return {
    open: (url) =>
      Effect.fail(new LinkOpenerError({ message: `Unsupported OS for opening URL: ${url}` })),
  }
}

export class LinkOpener extends Context.Service<LinkOpener, LinkOpenerService>()(
  "@gent/tui/src/os/LinkOpener",
) {
  static Live: Layer.Layer<LinkOpener, never, GentPlatform> = Layer.effect(
    LinkOpener,
    Effect.gen(function* () {
      const info = yield* (yield* GentPlatform).osInfo
      return LinkOpener.of(openerFor(info.platform))
    }),
  )

  static Test = (impl?: LinkOpenerService): Layer.Layer<LinkOpener, never> =>
    Layer.succeed(LinkOpener, LinkOpener.of(impl ?? { open: () => Effect.void }))
}

// ── terminal handover ───────────────────────────────────────────────────────

/**
 * Run an effect with the terminal handed to it: the renderer suspends first
 * and resumes when the effect ends, however it ends. A program that draws on
 * the terminal itself (an editor, a diff viewer) runs inside one. The verb is
 * the host's: the editor uses it, and a client extension reaches it as
 * `ClientShell.handover`.
 *
 * The terminal's signal keys go to the program, as they do for a program a
 * shell runs: each process the effect spawns joins gent's process group (the
 * terminal's foreground group), and gent lets ctrl+c and ctrl+\ pass until
 * the terminal is back.
 */
export type Handover = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>

/**
 * The signals a terminal's keys send its foreground group: ctrl+c (SIGINT)
 * and ctrl+\ (SIGQUIT). While a program holds the terminal they are the
 * program's, and gent lets them pass, as POSIX `system()` and git's editor
 * launch do. Ctrl+z (SIGTSTP) keeps its default: the shell stops gent and the
 * program together, and `fg` resumes both. Held, it would stop the program
 * alone while gent waits for it, and nothing would hold the terminal.
 */
const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT"] as const

/** How long the handover waits for its own signal before it gives the listeners back regardless. */
const SIGNAL_DRAIN_BOUND = Duration.seconds(1)

/**
 * The signal that marks the end of the terminal signals' turn. Its default
 * is to be ignored, and nothing in gent listens for it, so a mark that comes
 * late or without a listener does nothing.
 */
const DRAIN_MARK = "SIGURG"

/**
 * Wait until the listeners of every terminal signal the process got before
 * now have run. The process takes a signal at once but runs its listeners
 * later, in the order the signals came, so a ctrl+c the program ended on may
 * still wait when the program's end is seen. The mark the process sends
 * itself runs after those; its arrival at a listener of its own marks them
 * as run. (A mark of the same signal would not: its listener would hear the
 * waiting signal first, and the mark would reach gent.)
 */
const drainTerminalSignals = Effect.callback<void>((resume) => {
  const heard = () => {
    process.removeListener(DRAIN_MARK, heard)
    resume(Effect.void)
  }
  process.on(DRAIN_MARK, heard)
  // oxlint-disable-next-line effect/noGlobals -- the handover signals its own process, as no platform service can
  process.kill(process.pid, DRAIN_MARK)
  // On the bound: the listener comes off unheard.
  return Effect.sync(() => process.removeListener(DRAIN_MARK, heard))
}).pipe(Effect.timeoutOption(SIGNAL_DRAIN_BOUND), Effect.asVoid)

/**
 * Take the process's listeners of the terminal signals off until `effect`
 * ends, however it ends, and let the signals pass meanwhile. The passing
 * listener goes on before the others come off: a signal with no listener
 * would end gent. It comes off only after every signal that came while
 * `effect` ran has passed it (`drainTerminalSignals`): a ctrl+c the program
 * ended on never reaches gent late.
 */
const passTerminalSignals = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const pass = () => {}
      return TERMINAL_SIGNALS.map((signal) => {
        const listeners = process.listeners(signal)
        process.on(signal, pass)
        for (const listener of listeners) process.removeListener(signal, listener)
        return { signal, listeners, pass }
      })
    }),
    () => effect,
    (held) =>
      Effect.gen(function* () {
        yield* drainTerminalSignals
        for (const { signal, listeners, pass } of held) {
          for (const listener of listeners) process.on(signal, listener)
          process.removeListener(signal, pass)
        }
      }),
  )

/** `command` with each of its processes in gent's process group, not a session of its own. */
const inForeground = (command: ChildProcess.Command): ChildProcess.Command => {
  if (ChildProcess.isStandardCommand(command))
    return ChildProcess.make(command.command, command.args, { ...command.options, detached: false })
  return ChildProcess.pipeTo(
    inForeground(command.left),
    inForeground(command.right),
    command.options,
  )
}

/**
 * One terminal, one holder: a handover asked for while another runs waits
 * for its resume, so two programs never draw at once and the renderer never
 * resumes under a program still running.
 *
 * The signals pass inside the suspended span: the renderer takes its own
 * listeners off as it suspends and puts them back as it resumes (OpenTUI's
 * exit listener on ctrl+\), so gent holds only its own, and every signal the
 * program's span got has passed before the renderer listens again.
 */
export const makeHandover = (terminal: {
  readonly suspend: () => void
  readonly resume: () => void
}): Handover => {
  const holder = Semaphore.makeUnsafe(1)
  return (effect) =>
    Effect.acquireUseRelease(
      Effect.sync(terminal.suspend),
      () =>
        passTerminalSignals(
          Effect.updateService(effect, ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
            ChildProcessSpawner.make((command) => spawner.spawn(inForeground(command))),
          ),
        ),
      () => Effect.sync(terminal.resume),
    ).pipe(holder.withPermits(1))
}

const HandoverContext = createContext<Handover>()

/** `ExtensionUIProvider` provides it, and hands the same verb to the client extensions. */
export const HandoverProvider = HandoverContext.Provider

export const useHandover = (): Handover =>
  useRequiredContext(HandoverContext, "useHandover must be used within ExtensionUIProvider")

// ── external editor ─────────────────────────────────────────────────────────

/**
 * External editor support — Ctrl+G opens $VISUAL / $EDITOR / vi
 * with the current textarea content, returning the edited result.
 */

export function resolveEditor(
  visual: Option.Option<string>,
  editor: Option.Option<string>,
): string {
  return visual.pipe(
    Option.filter((value) => value.length > 0),
    Option.orElse(() => editor.pipe(Option.filter((value) => value.length > 0))),
    Option.getOrElse(() => "vi"),
  )
}

/** Split editor string into command + args (handles "code --wait", etc.) */
export function parseEditorCommand(editor: string): [string, ...string[]] {
  const parts = editor.trim().split(/\s+/)
  const cmd = Option.fromNullishOr(parts[0])
  if (Option.isNone(cmd) || cmd.value.length === 0) return ["vi"]
  return [cmd.value, ...parts.slice(1)]
}

const EditorResult = Schema.Union([
  Schema.TaggedStruct("applied", { content: Schema.String }),
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("error", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
type EditorResult = Schema.Schema.Type<typeof EditorResult>

/** The program ended on a signal: the spawner fails the exit code read of a program with none. */
const endedOnSignal = (cause: unknown): boolean =>
  PlatformError.isPlatformError(cause) &&
  cause.reason.module === "ChildProcess" &&
  cause.reason.method === "exitCode"

export const openExternalEditor = (
  currentContent: string,
  handover: Handover,
  editor: string,
): Effect.Effect<
  EditorResult,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const [cmd, ...args] = parseEditorCommand(editor)

      const tmpFile = yield* fs
        .makeTempFileScoped({ prefix: "gent-edit-", suffix: ".md" })
        .pipe(Effect.result)
      if (tmpFile._tag === "Failure") {
        return EditorResult.cases.error.make({
          message: `Failed to create tmp file: ${tmpFile.failure.message}`,
        })
      }
      const tmpPath = tmpFile.success

      const writeResult = yield* fs.writeFileString(tmpPath, currentContent).pipe(Effect.result)
      if (writeResult._tag === "Failure") {
        return EditorResult.cases.error.make({
          message: `Failed to write tmp file: ${writeResult.failure.message}`,
        })
      }

      // Some when the editor settles the result itself: a spawn error, or a non-zero exit.
      const settled = yield* handover(
        runProcess(cmd, [...args, tmpPath], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      ).pipe(
        Effect.map((result): Option.Option<EditorResult> =>
          Option.liftPredicate(EditorResult.cases.cancelled.make({}), () => result.exitCode !== 0),
        ),
        Effect.catchTag("ProcessError", (e) => {
          // An editor that ended on a signal (the reader's ctrl+c reaches it) has no exit code.
          let result: EditorResult = EditorResult.cases.error.make({
            message: `Editor failed: ${e.message}`,
          })
          if (endedOnSignal(e.cause)) result = EditorResult.cases.cancelled.make({})
          return Effect.succeedSome(result)
        }),
      )
      if (Option.isSome(settled)) return settled.value

      const content = yield* fs.readFileString(tmpPath).pipe(Effect.result)
      if (content._tag === "Failure") {
        return EditorResult.cases.error.make({
          message: `Failed to read tmp file: ${content.failure.message}`,
        })
      }
      return EditorResult.cases.applied.make({ content: content.success })
    }),
  )
