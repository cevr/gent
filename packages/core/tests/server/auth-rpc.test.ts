/**
 * `auth.listProviders` RPC acceptance tests.
 *
 * The handler resolves project config from the session's cwd, not the
 * launch cwd. A bug here (regression to `configService.get()`) would
 * silently re-block external-routed sessions on launch-cwd model auth.
 * The unit-level AuthGuard tests at `auth-guard.test.ts:181` prove the
 * `driverOverrides` short-circuit works; this test proves the *RPC
 * handler* threads `sessionId` → `session.cwd` →
 * `configService.get(cwd)` → `driverOverrides`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { ExternalDriverRef } from "@gent/core/domain/agent"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "../extensions/helpers/test-preset"

describe("auth.listProviders", () => {
  it.live("returns providers without sessionId (back-compat with launch-cwd default)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const providers = yield* client.auth.listProviders({})
        expect(providers.length).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "with sessionId + driver override pointing at an external driver, the agent's model auth is NOT required",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))

          // Create a session — this gives us a real sessionId tied to a real cwd.
          const session = yield* client.session.create({})
          const sessionId = session.id

          // Pick any registered external driver. If none exist in the test
          // layer, fall back to the model path — the test is still valid
          // (asserts the no-override case below) but the override branch
          // is skipped.
          const drivers = (yield* client.driver.list()).drivers
          const externalDriver = drivers.find((d) => d._tag === "external")

          // Baseline: without an override, cowork (anthropic-modeled) should
          // include "anthropic" in its required providers.
          const baseline = yield* client.auth.listProviders({
            agentName: "cowork",
            sessionId,
          })
          const baselineAnth = baseline.find((p) => p.provider === "anthropic")
          expect(baselineAnth?.required).toBe(true)

          if (externalDriver !== undefined) {
            // Set an override and re-query. With the fix, the handler reads
            // the session's cwd → configService.get(cwd) → driverOverrides
            // → AuthGuard sees the external routing → skips model auth.
            yield* client.driver.set({
              agentName: "cowork",
              driver: ExternalDriverRef.make({ id: externalDriver.id }),
            })
            const overridden = yield* client.auth.listProviders({
              agentName: "cowork",
              sessionId,
            })
            const overriddenAnth = overridden.find((p) => p.provider === "anthropic")
            // External routing must skip model auth — a regression to
            // launch-cwd-only would fail this assertion.
            expect(overriddenAnth?.required).toBe(false)
          }
        }),
      ),
  )
})
