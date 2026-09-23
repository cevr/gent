import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { GentPlatform } from "@gent/core/host"
import { runProcess } from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process"

// ── operating system service ────────────────────────────────────────────────

type OsPlatform = "darwin" | "win32" | "linux" | "other"

const resolvePlatform = (platform: string): OsPlatform => {
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "win32"
  if (platform === "linux") return "linux"
  return "other"
}

interface OsServiceDefinition {
  readonly platform: OsPlatform
}

export class OsService extends Context.Service<OsService, OsServiceDefinition>()(
  "@gent/tui/src/os/OsService",
) {
  static Live: Layer.Layer<OsService, never, GentPlatform> = Layer.effect(
    OsService,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      const info = yield* platform.osInfo
      return OsService.of({ platform: resolvePlatform(info.platform) })
    }),
  )

  static Test = (platform: OsPlatform): Layer.Layer<OsService> =>
    Layer.succeed(OsService, OsService.of({ platform }))
}

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

export class LinkOpener extends Context.Service<LinkOpener, LinkOpenerService>()(
  "@gent/tui/src/os/LinkOpener",
) {
  static LiveDarwin: Layer.Layer<LinkOpener> = Layer.succeed(
    LinkOpener,
    makeOpener("open", (url) => [url]),
  )

  static LiveWindows: Layer.Layer<LinkOpener> = Layer.succeed(
    LinkOpener,
    makeOpener("cmd", (url) => ["/c", "start", "", url]),
  )

  static LiveLinux: Layer.Layer<LinkOpener> = Layer.succeed(
    LinkOpener,
    makeOpener("xdg-open", (url) => [url]),
  )

  static LiveOther: Layer.Layer<LinkOpener> = Layer.succeed(
    LinkOpener,
    LinkOpener.of({
      open: (url) =>
        Effect.fail(
          new LinkOpenerError({
            message: `Unsupported OS for opening URL: ${url}`,
          }),
        ),
    }),
  )

  static Live: Layer.Layer<LinkOpener, never, OsService> = Layer.unwrap(
    Effect.gen(function* () {
      const os = yield* OsService
      if (os.platform === "darwin") return LinkOpener.LiveDarwin
      if (os.platform === "win32") return LinkOpener.LiveWindows
      if (os.platform === "linux") return LinkOpener.LiveLinux
      return LinkOpener.LiveOther
    }),
  )

  static Test = (impl?: LinkOpenerService): Layer.Layer<LinkOpener, never> =>
    Layer.succeed(LinkOpener, LinkOpener.of(impl ?? { open: () => Effect.void }))
}

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

const EditorProcessOutcome = Schema.TaggedUnion({
  ExitCode: { value: Schema.Finite },
  SpawnError: { message: Schema.String },
})

type EditorResult =
  | { _tag: "applied"; content: string }
  | { _tag: "cancelled" }
  | { _tag: "error"; message: string }

export const openExternalEditor = (
  currentContent: string,
  suspend: () => void,
  resume: () => void,
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
        return {
          _tag: "error",
          message: `Failed to create tmp file: ${tmpFile.failure.message}`,
        }
      }
      const tmpPath = tmpFile.success

      const writeResult = yield* fs.writeFileString(tmpPath, currentContent).pipe(Effect.result)
      if (writeResult._tag === "Failure") {
        return {
          _tag: "error",
          message: `Failed to write tmp file: ${writeResult.failure.message}`,
        }
      }

      yield* Effect.sync(suspend)

      const editorOutcome = yield* runProcess(cmd, [...args, tmpPath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).pipe(
        Effect.map((result) =>
          EditorProcessOutcome.cases.ExitCode.make({ value: result.exitCode }),
        ),
        Effect.catchTag("ProcessError", (e) =>
          Effect.succeed(EditorProcessOutcome.cases.SpawnError.make({ message: e.message })),
        ),
        Effect.ensuring(Effect.sync(resume)),
      )

      if (editorOutcome._tag === "SpawnError") {
        return { _tag: "error", message: `Editor failed: ${editorOutcome.message}` }
      }
      if (editorOutcome.value !== 0) {
        return { _tag: "cancelled" }
      }

      const content = yield* fs.readFileString(tmpPath).pipe(Effect.result)
      if (content._tag === "Failure") {
        return { _tag: "error", message: `Failed to read tmp file: ${content.failure.message}` }
      }
      return { _tag: "applied", content: content.success }
    }),
  )
