/**
 * The site on Railway: its project and its service, Effect-native with no
 * Dockerfile.
 *
 * - `main: import.meta.url` makes this file the bundle entry. Alchemy bundles
 *   it with Rolldown and runs it on `node:26-slim` as `/app/index.mjs`. Alchemy
 *   provides the platform services (`FileSystem`, `Path`, `HttpClient`) to the
 *   props and to the constructor, on the deploy machine and in the image.
 * - The repo root `install.sh`, when it exists at deploy time, is copied
 *   beside the bundle (`/app/install.sh`). Its contents are hashed, so a
 *   change to it redeploys. The site serves it when GitHub has no release.
 * - `prod` names the project `gent` and the service `site`, and serves only
 *   through `gent.cvr.im` (`alchemy.run.ts`). Every other stage is a
 *   throwaway with generated names and a generated `*.up.railway.app` URL.
 */
import * as Alchemy from "alchemy"
// Subpath imports: the `alchemy/Railway` index re-exports `Website`, whose
// framework adapters import the optional `@alchemy.run/frontend-frameworks`.
import { Project } from "alchemy/Railway/Project"
import { Service } from "alchemy/Railway/Service"
import { Effect, FileSystem, Path } from "effect"
import { HttpRouter } from "effect/http"
import * as Site from "./site"

/** The port the service listens on and the custom domain targets. */
export const PORT = 8080

/** The owner's Railway workspace, where the other cvr.im services run. */
const WORKSPACE = "e7bf0e51-695c-4c12-aea3-d46949594a0f"

/** The installer's name beside the bundle (`/app/install.sh`). */
const BUNDLED_INSTALLER = "install.sh"

/** True on the one stage that owns `gent.cvr.im`. */
const isProd = (stage: string) => stage === "prod"

/**
 * Prod adopts the project and service it finds under its own names, so a
 * deploy after lost local state takes them back instead of making copies.
 * Throwaway stages have generated names and adopt nothing.
 */
export const adoptInProd = Alchemy.AdoptPolicy.adopt(
  Alchemy.Stack.useSync((stack) => isProd(stack.stage)),
)

/** The directory of this module: `apps/site/src` on the deploy machine, `/app` in the image. */
const moduleDirectory = Effect.gen(function* () {
  const path = yield* Path.Path
  // A module URL that is not a file URL is a broken bundle: a defect.
  return path.dirname(yield* Effect.orDie(path.fromFileUrl(new URL(import.meta.url))))
})

/**
 * The repo root `install.sh` to copy into the image, when the repo has one.
 * A copy that fails the site's installer check stops the deploy: the site
 * would otherwise ship a fallback that is not gent's installer.
 */
const bundledInstallerFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = path.join(yield* moduleDirectory, "..", "..", "..", "install.sh")
  if (!(yield* Effect.orDie(fs.exists(source)))) return []
  yield* Site.checkInstaller(yield* Effect.orDie(fs.readFileString(source))).pipe(
    Effect.catchTag("InstallerRejected", (rejected) =>
      Effect.die(new Error(`${source} is not gent's installer: ${rejected.reason}`)),
    ),
  )
  return [{ source, dest: BUNDLED_INSTALLER }]
})

/**
 * The project. A different `workspaceId` would replace it, so it is pinned.
 */
export const GentProject = Project(
  "GentProject",
  Alchemy.Stack.useSync((stack) => {
    if (isProd(stack.stage)) return { name: "gent", workspaceId: WORKSPACE }
    return { workspaceId: WORKSPACE }
  }),
).pipe(adoptInProd)

export default class Server extends Service<Server>()(
  "Site",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const common = {
      project: GentProject,
      main: import.meta.url,
      port: PORT,
      healthcheck: "/healthz",
      restartPolicyType: "ON_FAILURE" as const,
      restartPolicyMaxRetries: 10,
      extraFiles: yield* bundledInstallerFile,
    }
    // `gent.cvr.im` serves prod. Throwaway stages need the generated URL.
    if (isProd(stage)) return { ...common, name: "site", publicDomain: false }
    return { ...common, publicDomain: true }
  }),
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const bundledInstaller = yield* Effect.option(
      fs.readFileString(path.join(yield* moduleDirectory, BUNDLED_INSTALLER)),
    )
    const handler = yield* HttpRouter.toHttpEffect(Site.layer({ bundledInstaller }))
    return { fetch: handler }
  }),
) {}
