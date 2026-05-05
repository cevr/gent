import { Context, Effect, Layer } from "effect"
import { GentPlatform } from "@gent/core/runtime/gent-platform.js"

export type OsPlatform = "darwin" | "win32" | "linux" | "other"

const resolvePlatform = (platform: string): OsPlatform => {
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "win32"
  if (platform === "linux") return "linux"
  return "other"
}

export interface OsServiceShape {
  readonly platform: OsPlatform
}

export class OsService extends Context.Service<OsService, OsServiceShape>()(
  "@gent/tui/src/services/os-service/OsService",
) {
  static Live: Layer.Layer<OsService, never, GentPlatform> = Layer.effect(
    OsService,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      const info = yield* platform.osInfo
      return { platform: resolvePlatform(info.platform) }
    }),
  )

  static Test = (platform: OsPlatform): Layer.Layer<OsService> =>
    Layer.succeed(OsService, { platform })
}
