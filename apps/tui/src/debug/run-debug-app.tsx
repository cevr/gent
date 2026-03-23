import { render } from "@opentui/solid"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Config, Effect, Layer, Option, type ServiceMap } from "effect"
import * as os from "node:os"
import { RegistryProvider } from "../atom-solid/solid"
import { App } from "../app"
import { resolveDebugBootstrap } from "../app-bootstrap"
import { ClientProvider } from "../client/index"
import { EnvProvider } from "../env/context"
import { RouterProvider } from "../router/index"
import { WorkspaceProvider } from "../workspace/index"
import { joinPath } from "../platform/path-runtime"
import { createDependencies } from "@gent/core/server/dependencies.js"
import { AppServicesLive } from "@gent/core/server/index.js"
import { prepareDebugSession } from "@gent/core/debug/session.js"
import { makeDirectGentClient } from "@gent/sdk"
import { GentLogger } from "@gent/core/runtime/logger.js"
import { GentTracerLive, clearTraceLogIfRoot } from "@gent/core/runtime/tracer.js"
import { LinkOpener } from "@gent/core/domain/link-opener.js"
import { OsService } from "@gent/core/domain/os-service.js"

interface DebugAppInput {
  cwd: string
  uiServices: ServiceMap.ServiceMap<unknown>
  env: {
    visual: string | undefined
    editor: string | undefined
  }
  atomCacheMax: number
}

const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)
const TracerLayer = Layer.merge(GentTracerLive, clearTraceLogIfRoot)
const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeDebugCoreLayer = (options: { cwd: string }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cwd = options.cwd
      const homeOpt = yield* Config.option(Config.string("HOME"))
      const home = Option.getOrElse(homeOpt, () => os.homedir())
      const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
      const dataDir = Option.getOrElse(dataDirOpt, () => joinPath(home, ".gent"))
      const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
      const dbPath = Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db"))
      const authFilePath = Option.isSome(dataDirOpt)
        ? joinPath(dataDir, "auth.json.enc")
        : undefined
      const authKeyPath = Option.isSome(dataDirOpt) ? joinPath(dataDir, "auth.key") : undefined

      const serverDeps = createDependencies({
        cwd,
        home,
        platform: process.platform,
        dbPath,
        persistenceMode: "memory",
        providerMode: "debug-scripted",
        actorRuntime: "local",
        ...(authFilePath !== undefined ? { authFilePath } : {}),
        ...(authKeyPath !== undefined ? { authKeyPath } : {}),
      }).pipe(Layer.provide(PlatformLayer), Layer.provide(GentLogger), Layer.provide(TracerLayer))
      const coreLive = AppServicesLive.pipe(Layer.provide(serverDeps))
      return Layer.mergeAll(coreLive, serverDeps, LinkLayer)
    }),
  )

export const runDebugApp = Effect.fn("runDebugApp")(function* (input: DebugAppInput) {
  const debugServices = (yield* Layer.build(
    makeDebugCoreLayer({ cwd: input.cwd }),
  )) as ServiceMap.ServiceMap<unknown>
  const gentClient = yield* makeDirectGentClient.pipe(Effect.provideServices(debugServices))
  const debugSession = yield* prepareDebugSession(input.cwd).pipe(
    Effect.provideServices(debugServices),
  )
  const bootstrap = resolveDebugBootstrap(debugSession)

  yield* Effect.sync(() =>
    render(() => (
      <EnvProvider env={input.env}>
        <WorkspaceProvider cwd={input.cwd} services={input.uiServices}>
          <RegistryProvider services={input.uiServices} maxEntries={input.atomCacheMax}>
            <ClientProvider client={gentClient} initialSession={bootstrap.initialSession}>
              <RouterProvider initialRoute={bootstrap.initialRoute}>
                <App
                  initialPrompt={bootstrap.initialPrompt}
                  missingAuthProviders={bootstrap.missingAuthProviders}
                  debugMode={bootstrap.debugMode}
                />
              </RouterProvider>
            </ClientProvider>
          </RegistryProvider>
        </WorkspaceProvider>
      </EnvProvider>
    )),
  )

  return yield* Effect.never
})
