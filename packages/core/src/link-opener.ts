import { Context, Effect, Layer, Schema } from "effect"
import { OsService } from "./os-service"

export class LinkOpenerError extends Schema.TaggedError<LinkOpenerError>()("LinkOpenerError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface LinkOpenerService {
  readonly open: (url: string) => Effect.Effect<void, LinkOpenerError>
}

const makeOpener = (command: string, argsForUrl: (url: string) => string[]): LinkOpenerService => ({
  open: Effect.fn("LinkOpener.open")((url: string) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([command, ...argsForUrl(url)], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const code = await proc.exited
        if (code !== 0) {
          const errText = await new Response(proc.stderr).text()
          throw new Error(errText || `Exit code ${code}`)
        }
      },
      catch: (e) =>
        new LinkOpenerError({
          message: `Failed to open URL: ${url}`,
          cause: e,
        }),
    }),
  ),
})

export class LinkOpener extends Context.Tag("@gent/core/src/link-opener/LinkOpener")<
  LinkOpener,
  LinkOpenerService
>() {
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

  static Live: Layer.Layer<LinkOpener, never, OsService> = Layer.unwrapEffect(
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
