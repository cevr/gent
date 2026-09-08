/**
 * `/btw` side questions. Each ask runs an ephemeral child of the current
 * agent on a copy of this branch's history, with tools off and low
 * reasoning. Nothing from the side conversation lands on the branch; the
 * client replays earlier side turns inside the next prompt.
 */
import { Effect, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  defineRequests,
  ExtensionContext,
  makeRunSpec,
  request,
  requireCurrentAgent,
} from "@gent/core/extensions/api"
import {
  BTW_EXTENSION_ID,
  MAXIMUM_SIDE_QUESTION_CHARS,
  SideQuestionInput,
  SideQuestionOutput,
  type SideTurn,
} from "./btw-protocol.js"

export {
  BTW_EXTENSION_ID,
  SideQuestionInput,
  SideQuestionOutput,
  SideTurn,
} from "./btw-protocol.js"

export class SideQuestionError extends Schema.TaggedError<SideQuestionError>()(
  "SideQuestionError",
  { message: Schema.String },
) {}

export const SIDE_QUESTION_INSTRUCTION =
  "Answer this side question using only the conversation context above. Do not use tools and do not run code. The user may send follow-up side questions; none of this side conversation is added to the main session."

const replayTurns = (previous: ReadonlyArray<SideTurn>) =>
  previous
    .map((turn) => `<side_question>\n${turn.question}\n</side_question>\n\n${turn.answer}`)
    .join("\n\n")

/** The child sees the branch history, then one user message carrying the side exchange. */
export const sideQuestionPrompt = (input: SideQuestionInput): string => {
  const current = `<side_question>\n${input.question}\n</side_question>`
  if (input.previous.length === 0) {
    return `<side_question>\n${SIDE_QUESTION_INSTRUCTION}\n\n${input.question}\n</side_question>`
  }
  return `${SIDE_QUESTION_INSTRUCTION}\n\nEarlier side questions and answers in this exchange:\n\n${replayTurns(input.previous)}\n\n${current}`
}

const askError = (reason: string) =>
  new CapabilityError({ extensionId: BTW_EXTENSION_ID, capabilityId: "btw.ask", reason })

export const BtwRpc = defineRequests(BTW_EXTENSION_ID, {
  Ask: request({
    id: "btw.ask",
    description: "Answer a side question from the branch history without touching the branch",
    input: SideQuestionInput,
    output: SideQuestionOutput,
    execute: Effect.fn("BtwRpc.Ask")(
      function* (input: SideQuestionInput) {
        const question = input.question.trim()
        if (question.length === 0) {
          return yield* new SideQuestionError({ message: "Side question is empty" })
        }
        if ([...question].length > MAXIMUM_SIDE_QUESTION_CHARS) {
          return yield* new SideQuestionError({
            message: `Side question exceeds ${MAXIMUM_SIDE_QUESTION_CHARS} characters`,
          })
        }
        const ctx = yield* ExtensionContext
        const agent = yield* requireCurrentAgent
        const result = yield* ctx.Agent.run({
          agent,
          prompt: sideQuestionPrompt({ question, previous: input.previous }),
          runSpec: makeRunSpec({
            persistence: "ephemeral",
            history: "inherit",
            overrides: {
              allowedTools: [],
              deniedTools: ["cell"],
              reasoningEffort: "low",
              systemPromptAddendum: SIDE_QUESTION_INSTRUCTION,
            },
          }),
        })
        if (result._tag === "error") {
          return yield* new SideQuestionError({ message: result.error })
        }
        return { answer: result.text }
      },
      (effect) => Effect.mapError(effect, (cause) => askError(cause.message)),
    ),
  }),
})

export const BtwExtension = defineExtension({
  id: BTW_EXTENSION_ID,
  requests: [BtwRpc.Ask],
})
