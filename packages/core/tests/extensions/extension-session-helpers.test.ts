/**
 * Regression suite for the `estimateContextPercent` extension helper.
 *
 * The helper replaces the old `Session.estimateContextPercent` plumbed
 * method (W35-C3). Pin its public contract — composition over
 * `ctx.Session.listMessages`, default model fallback, propagation of a
 * delegated `listMessages` failure as `ExtensionServiceError` — so
 * future refactors cannot silently re-introduce a host-facet method or
 * skip the typed-error surface.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { DEFAULT_MODEL_ID } from "../../src/domain/agent.js"
import { MessageId, SessionId, BranchId } from "../../src/domain/ids.js"
import { dateFromMillis, Message } from "../../src/domain/message.js"
import { estimateContextPercent as pureEstimateContextPercent } from "../../src/runtime/context-estimation.js"
import {
  estimateContextPercent,
  ExtensionContext,
  ExtensionServiceError,
} from "../../src/domain/extension-services.js"
import { testToolContext } from "../../src/test-utils/index.js"

const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const FIXTURE_DATE = dateFromMillis(0)

const textMessage = (id: string, content: string): Message =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId: SESSION_ID,
    branchId: BRANCH_ID,
    role: "user",
    parts: [Prompt.textPart({ text: content })],
    metadata: undefined,
    createdAt: FIXTURE_DATE,
  })

const contextLayerFromMessages = (messages: ReadonlyArray<Message>) => {
  const base = testToolContext()
  return Layer.succeed(ExtensionContext, {
    ...base,
    Session: {
      ...base.Session,
      listMessages: () => Effect.succeed(messages),
    },
  })
}

describe("estimateContextPercent helper", () => {
  it.live("composes Session.listMessages with the pure estimator", () =>
    Effect.gen(function* () {
      // Large fixture so the expected percent is strictly > 0; if the helper
      // ever drops the listed messages and feeds [] into the pure estimator,
      // it would return only the system-overhead floor and break equality.
      const messages = [textMessage("m1", "hello world ".repeat(50_000))]
      const expected = pureEstimateContextPercent(messages, DEFAULT_MODEL_ID)
      expect(expected).toBeGreaterThan(0)
      const percent = yield* estimateContextPercent({ modelId: DEFAULT_MODEL_ID }).pipe(
        Effect.provide(contextLayerFromMessages(messages)),
      )
      expect(percent).toBe(expected)
    }),
  )

  it.live("defaults to DEFAULT_MODEL_ID when modelId is not provided", () =>
    Effect.gen(function* () {
      const messages = [textMessage("m1", "x".repeat(10_000))]
      const layer = contextLayerFromMessages(messages)
      const withDefault = yield* estimateContextPercent().pipe(Effect.provide(layer))
      const explicit = yield* estimateContextPercent({ modelId: DEFAULT_MODEL_ID }).pipe(
        Effect.provide(layer),
      )
      expect(withDefault).toBe(explicit)
    }),
  )

  it.live("propagates listMessages failures as ExtensionServiceError", () =>
    Effect.gen(function* () {
      const base = testToolContext()
      const failure = new ExtensionServiceError({
        service: "ExtensionSession",
        operation: "listMessages",
        message: "boom",
      })
      const ctxLayer = Layer.succeed(ExtensionContext, {
        ...base,
        Session: { ...base.Session, listMessages: () => Effect.fail(failure) },
      })
      const exit = yield* Effect.exit(estimateContextPercent().pipe(Effect.provide(ctxLayer)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(ExtensionServiceError)(error.value)).toBe(true)
      if (!Schema.is(ExtensionServiceError)(error.value)) return
      expect(error.value.service).toBe("ExtensionSession")
      expect(error.value.operation).toBe("listMessages")
    }),
  )
})
