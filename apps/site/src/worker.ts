/**
 * The site on Cloudflare: one Worker whose `fetch` is the site's routes
 * (`./site.ts`).
 *
 * - `main: import.meta.url` makes this file the bundle entry. Alchemy bundles
 *   it with Rolldown at deploy time; the Worker reaches GitHub through
 *   `FetchHttpClient`, the Worker's own `fetch`.
 * - The repo root `install.sh`, through the `apps/site/install.sh` link, is
 *   inlined into the bundle as text (the `.sh` module type below, and
 *   `with { type: "text" }` for Bun at plan time). A change to it changes
 *   the bundle hash, so it redeploys. A copy that fails the site's installer
 *   check stops the plan: the site would otherwise ship a fallback that is
 *   not gent's installer.
 * - `prod` takes the Worker name `gent-site` and the `gent.cvr.im` custom
 *   domain, and turns its `workers.dev` host off. Any other stage is a
 *   throwaway on a generated `workers.dev` name and never touches the domain.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Stage } from "alchemy/Stage"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import installer from "../install.sh" with { type: "text" }
import * as Site from "./site"

export const DOMAIN = "gent.cvr.im"

/** Rolldown reads `.sh` imports as text: the bundled installer. */
const BUILD = { input: { moduleTypes: { ".sh": "text" } } } as const

/** The props, by stage. The running Worker reads them without one. */
const props = Effect.gen(function* () {
  const stage = yield* Effect.serviceOption(Stage)
  const base = { main: import.meta.url, build: BUILD }
  if (!Option.contains(stage, "prod")) return base
  return { ...base, name: "gent-site", workersDev: false, domain: DOMAIN }
})

/** The repo's installer, checked once: at plan time on the deploy machine, then per isolate. */
const bundledInstaller = Site.checkInstaller(installer).pipe(
  Effect.catchTag("InstallerRejected", (rejected) =>
    Effect.die(new Error(`install.sh is not gent's installer: ${rejected.reason}`)),
  ),
)

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Site",
  props,
  Effect.gen(function* () {
    const script = yield* bundledInstaller
    const handler = yield* HttpRouter.toHttpEffect(
      Site.layer({ bundledInstaller: Option.some(script) }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
    )
    return { fetch: handler }
  }),
) {}
