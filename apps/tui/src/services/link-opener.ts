import { Context, Effect, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { runProcess } from "@gent/core/utils/run-process"
import { OsService } from "./os-service"

export class LinkOpenerError extends Schema.TaggedErrorClass<LinkOpenerError>()("LinkOpenerError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface LinkOpenerService {
  readonly open: (
    url: string,
  ) => Effect.Effect<void, LinkOpenerError, ChildProcessSpawner.ChildProcessSpawner>
}

const makeOpener = (command: string, argsForUrl: (url: string) => string[]): LinkOpenerService => ({
  open: Effect.fn("LinkOpener.open")((url: string) =>
    runProcess(command, argsForUrl(url), { stdout: "ignore", stderr: "pipe" }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new LinkOpenerError({
                message: `Failed to open URL: ${url}: ${result.stderr || `Exit code ${result.exitCode}`}`,
              }),
            ),
      ),
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
  "@gent/tui/src/services/link-opener/LinkOpener",
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

  static LiveOther: Layer.Layer<LinkOpener> = Layer.succeed(LinkOpener, {
    open: (url) =>
      Effect.fail(
        new LinkOpenerError({
          message: `Unsupported OS for opening URL: ${url}`,
        }),
      ),
  })

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
    Layer.succeed(LinkOpener, impl ?? { open: () => Effect.void })
}
