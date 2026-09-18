/**
 * The parent branch admits at most four unfinished background children. A
 * fifth and sixth delegation in the same step must fail as ordinary tool
 * results, not as a turn failure: the model reads the rejection and keeps
 * going. This is the shape that broke in the gamut testbed — six `delegate`
 * calls in one `Promise.all`, two over the cap — so the cap must reject the
 * extra children while the four admitted ones still run and deliver.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Predicate } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import {
  LanguageModelLayers,
  multiToolCallStep,
  textStep,
  waitFor,
} from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/index"
import { e2ePreset } from "../helpers/test-preset"

const backgroundCall = (todo: string) => ({
  toolName: "delegate",
  input: { todo, background: true },
})

/**
 * The failed `delegate` results on the parent branch that name the cap. A
 * failed tool result carries its message in `result`, so the cap rejection is
 * readable model input rather than a dead turn.
 */
const cappedResults = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => {
      if (part.type !== "tool-result" || part.name !== "delegate" || !part.isFailure) return false
      const result = part.result
      if (!Predicate.isReadonlyObject(result)) return false
      return String(result["error"]).includes("unfinished child starts")
    })

describe("background delegation over the pending-start cap", () => {
  it.live(
    "rejects the children past the cap as tool results and still runs the admitted four",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              backgroundCall("Reply with the single word one"),
              backgroundCall("Reply with the single word two"),
              backgroundCall("Reply with the single word three"),
              backgroundCall("Reply with the single word four"),
              backgroundCall("Reply with the single word five"),
              backgroundCall("Reply with the single word six"),
            ),
            // The parent's follow-up turn and the four admitted children all
            // draw from this one queue, in whatever order they reach the model.
            ...Array.from({ length: 8 }, () => textStep("ack")),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          yield* client.message.send({ sessionId, branchId, content: "delegate six tasks" })

          // The two over-cap delegations come back as ordinary tool results on
          // the parent branch. A turn that died on the rejection would never
          // persist them.
          const afterAdmission = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => cappedResults(current.messages).length >= 2,
            10_000,
            "the capped delegations returned as tool results",
          )
          const rejected = cappedResults(afterAdmission.messages)
          // Two of the six are over the cap of four.
          expect(rejected).toHaveLength(2)

          // The four admitted children still deliver; the cap rejected the
          // extras without disturbing them.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.filter(
                (message) => message.metadata?.customType === "child-completion",
              ).length >= 4 && current.runtime._tag === "Idle",
            20_000,
            "the four admitted children delivered their completions",
          )
          expect(
            settled.messages.filter(
              (message) => message.metadata?.customType === "child-completion",
            ),
          ).toHaveLength(4)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})
