/**
 * The deploy, checked against real Cloudflare: a throwaway `test_$USER` stage
 * is deployed, probed and destroyed in one scope, so a failure destroys it too.
 *
 * Outside the test lane's file pattern on purpose, so the gate never deploys.
 * Run it with `bun run test:deploy` before handing off a change to the stack,
 * the Worker, or the Alchemy or Effect versions.
 */
import { expect } from "bun:test"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Test from "alchemy/Test/Bun"
import { Effect, Option, Schedule } from "effect"
import { HttpClient } from "effect/http"
import Stack, { providers } from "../alchemy.run"
import * as Site from "../src/site"

const { test, deploy, destroy } = Test.make({ providers, state: Cloudflare.state() })

const deployed = Effect.acquireRelease(deploy(Stack), () => destroy(Stack).pipe(Effect.orDie))

test(
  "the Worker serves the landing page, the health check and the installer",
  Effect.gen(function* () {
    const outputs = yield* deployed
    const url = yield* Effect.fromOption(Option.fromNullishOr(outputs.url))
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    // A fresh workers.dev host can answer 404 for a few seconds after deploy.
    const get = (path: string) =>
      client
        .get(`${url}${path}`)
        .pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }))

    const home = yield* get("/")
    expect(home.headers["content-type"]).toContain("text/html")
    expect(yield* home.text).toContain(Site.INSTALL_LINE)

    const health = yield* get("/healthz")
    expect(yield* health.text).toBe("ok")

    // The release copy when GitHub has one, else the copy bundled at deploy:
    // never the "no release yet" script, since the repo has an installer.
    const install = yield* get("/install.sh")
    expect(install.headers["x-gent-install-source"]).toMatch(/^(release|bundled)$/)
    expect(yield* install.text).toContain(Site.INSTALLER_MARKER)
  }).pipe(Effect.scoped),
  { timeout: 600_000 },
)
