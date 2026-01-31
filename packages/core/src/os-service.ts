import { Context, Layer } from "effect"

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

export class OsService extends Context.Tag("@gent/core/src/os-service/OsService")<
  OsService,
  OsServiceShape
>() {
  static Live: Layer.Layer<OsService> = Layer.succeed(OsService, {
    platform: resolvePlatform(process.platform),
  })

  static Test = (platform: OsPlatform): Layer.Layer<OsService> =>
    Layer.succeed(OsService, { platform })
}
