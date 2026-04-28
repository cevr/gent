/**
 * Actor lifecycle canary — exercises the public session actor over fresh RPC
 * scopes. This locks the scope boundary without reviving the deleted
 * extension message transport.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "./helpers/test-preset"

describe("Actor lifecycle across RPC boundaries", () => {
  it.live(
    "session actor survives RPC request boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const before = yield* client.actor.getMetrics({ sessionId, branchId })
          yield* client.message.send({ sessionId, branchId, content: "hello" })
          const after = yield* client.actor.getMetrics({ sessionId, branchId })

          expect(after.turns).toBeGreaterThanOrEqual(before.turns)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
