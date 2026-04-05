/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { onMount } from "solid-js"
import { App } from "../src/app"
import { resolveInitialState } from "../src/app-bootstrap"
import { Route, useRouter, type RouterContextValue } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { destroyRenderSetup, renderWithProviders } from "../tests/render-harness"
import { baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { Gent } from "@gent/sdk"
import { waitForCondition, waitForFrame, repoRoot } from "./helpers"

function StateProbe(props: {
  readonly onReady: (ctx: { client: ClientContextValue; router: RouterContextValue }) => void
}) {
  const client = useClient()
  const router = useRouter()
  onMount(() => {
    props.onReady({ client, router })
  })
  return <box />
}

describe("app bootstrap", () => {
  test("continue mode resumes the latest session for cwd", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(baseLocalLayer())

          const first = yield* client.session.create({ cwd: repoRoot })
          yield* Effect.sleep("5 millis")
          const second = yield* client.session.create({ cwd: repoRoot })

          const state = yield* resolveInitialState({
            client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.none(),
            promptArg: Option.none(),
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.session.id).toBe(second.sessionId)
          expect(state.session.id).not.toBe(first.sessionId)
        }),
      ),
    )
  }, 5_000)

  test("continue mode creates a session from prompt when none exists", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(baseLocalLayer())

          const state = yield* resolveInitialState({
            client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.some("bootstrap prompt"),
            promptArg: Option.none(),
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.prompt).toBe("bootstrap prompt")
          expect(state.session.branchId).toBeDefined()
        }),
      ),
    )
  }, 5_000)

  test("startup navigates to session without auth gate blocking", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(baseLocalLayer())
          let ctx: { client: ClientContextValue; router: RouterContextValue } | undefined

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe
                    onReady={(c) => {
                      ctx = c
                    }}
                  />
                  <App
                    startup={{
                      cwd: repoRoot,
                      continue_: false,
                    }}
                  />
                </>
              ),
              {
                client,
                runtime,
                initialRoute: Route.loading(),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          expect(ctx).toBeDefined()

          // Wait for bootstrap to complete — route transitions from "loading" to "session"
          yield* waitForCondition(
            setup,
            () => ctx!.router.route()._tag === "session",
            "route = session",
          )

          expect(ctx!.router.route()._tag).toBe("session")
          // Agent should be set (not undefined) after bootstrap
          expect(ctx!.client.agent()).toBeDefined()

          // Allow auth gate RPC to complete through Effect runtime
          yield* Effect.sleep("200 millis")

          // After settling, the session view should appear (not "Loading session…")
          const frame = yield* waitForFrame(
            setup,
            (f) => !f.includes("Loading session"),
            "no loading session",
            2_000,
          )
          expect(frame).not.toContain("Loading session")
        }),
      ),
    )
  }, 10_000)
})
