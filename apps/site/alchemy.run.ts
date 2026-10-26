/**
 * gent.cvr.im, declared as an Alchemy stack: one Cloudflare Worker serving
 * the landing page, `/healthz` and `/install.sh` (`src/worker.ts`). Run it
 * from this directory: `bun run plan`, `bun run deploy` (both `--stage prod`).
 *
 * - `prod` owns `gent.cvr.im` as the Worker's custom domain: Cloudflare makes
 *   the DNS record and the certificate in the `cvr.im` zone itself.
 * - Any other stage (`agent-*`, `test_$USER`) is a throwaway on a generated
 *   `*.workers.dev` URL with no domain, destroyed with
 *   `bunx alchemy destroy alchemy.run.ts --stage <name> --yes`.
 * - State lives in the Cloudflare state store, so every machine and CI see
 *   the same resources.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import Site from "./src/worker"

/** The stack's providers. */
export const providers = Cloudflare.providers()

export default Alchemy.Stack(
  "gent-site",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const site = yield* Site
    return { url: site.url }
  }),
)
