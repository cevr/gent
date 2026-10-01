import { Effect, Layer, Option, Schema } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { type CapturedRequest, type FakeFetchState, fakeFetchLayer } from "@gent/core/test-utils"
import { encodeExternalJson } from "./external-wire.js"

/**
 * One System One round trip, TypeSafe's classifier API, against a captured
 * fake `fetch`: the drivers that serve Jev (TypeSafe direct and OpenCode Zen)
 * share it. No test reaches a provider.
 */

/** A classify, a rate and a probability question about one support ticket. */
const ticketDecisions = Decision.make({
  input: Schema.Json,
  decisions: {
    topic: Decision.classify({
      instructions: "What the ticket is about",
      criteria: { billing: "Payments and invoices", other: "Anything else" },
    }),
    urgency: Decision.rate({
      instructions: "How soon it needs an answer",
      criteria: ["later", "soon", "now"],
    }),
    urgent: Decision.probability({ instructions: "Needs action today" }),
  },
})

export const TICKET = { text: "My payments failed for three days" }

/** System One's reply to the ticket questions, as the API writes it. */
const systemOneReply = () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: encodeExternalJson({
    model: "jev",
    answers: {
      topic: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.9, other: 0.1 },
        confidence: 0.8,
      },
      urgency: {
        type: "score",
        score: 2,
        probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
        confidence: 0.7,
      },
      urgent: { type: "noul", noul: 0.25 },
    },
    usage: { input_tokens: 30, output_tokens: 0 },
  }),
})

/** Ask the ticket questions through `layer`, each request captured into `state`. */
export const decideTicket = (
  layer: Layer.Layer<DecisionModel.DecisionModel>,
  state: FakeFetchState,
) =>
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    return yield* model.decide(ticketDecisions, { input: TICKET })
  }).pipe(
    Effect.provide(Layer.provideMerge(layer, fakeFetchLayer(state, systemOneReply))),
    Effect.scoped,
  )

const SystemOneBody = Schema.fromJsonString(Schema.JsonObject)

/** The JSON body of a captured System One request. */
export const systemOneBody = (request: CapturedRequest) =>
  Schema.decodeEffect(SystemOneBody)(Option.getOrThrow(Option.fromUndefinedOr(request.body)))

/** The questions every ticket request carries, in System One's words. */
export const TICKET_QUESTIONS = {
  topic: {
    type: "choice",
    instructions: "What the ticket is about",
    criteria: { billing: "Payments and invoices", other: "Anything else" },
  },
  urgency: {
    type: "score",
    instructions: "How soon it needs an answer",
    criteria: ["later", "soon", "now"],
  },
  urgent: { type: "noul", instructions: "Needs action today" },
}
