import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { GentPlatform } from "@gent/core/host"
import { runProcess } from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/process"

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

      yield* Effect.sync(suspend)

      // Some when the editor settles the result itself: a spawn error, or a non-zero exit.
      const settled = yield* runProcess(cmd, [...args, tmpPath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).pipe(
        Effect.map((result): Option.Option<EditorResult> =>
          Option.liftPredicate(EditorResult.cases.cancelled.make({}), () => result.exitCode !== 0),
        ),
        Effect.catchTag("ProcessError", (e) =>
          Effect.succeedSome(
            EditorResult.cases.error.make({ message: `Editor failed: ${e.message}` }),
          ),
        ),
        Effect.ensuring(Effect.sync(resume)),
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
