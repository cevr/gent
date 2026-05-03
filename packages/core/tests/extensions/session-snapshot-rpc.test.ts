/**
 * Session snapshot canary: exercises product RPCs over fresh request scopes.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent, extractText } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "./helpers/test-preset"

describe("Session snapshot across RPC boundaries", () => {
  it.live(
    "session snapshot observes messages across RPC request boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const before = yield* client.session.getSnapshot({ sessionId, branchId })
          yield* client.message.send({ sessionId, branchId, content: "hello" })
          const after = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) =>
              snapshot.messages.some((message) => extractText(message.parts) === "hello") &&
              snapshot.metrics.turns > 0,
            5_000,
            "session snapshot user message and metrics",
          )

          expect(after.messages.length).toBeGreaterThanOrEqual(before.messages.length)
          expect(after.messages.map((message) => extractText(message.parts))).toContain("hello")
          expect(after.metrics.turns).toBeGreaterThan(0)
          expect(after.metrics.lastInputTokens).toBeGreaterThan(0)
          expect(after.metrics.lastModelId).toBeDefined()
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
