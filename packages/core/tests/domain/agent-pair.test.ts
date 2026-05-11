import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Option, Schema } from "effect"
import { NoModeledAgentsError, resolveDualModelPair } from "@gent/core-internal/domain/agent-pair"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { ModelId } from "@gent/core-internal/domain/model"
import { ExternalDriverRef } from "@gent/core-internal/domain/driver"

const agent = (name: string, model?: string): AgentDefinition =>
  AgentDefinition.make({
    name: AgentName.make(name),
    description: name,
    ...(model !== undefined ? { model: ModelId.make(model) } : {}),
  })

const externalAgent = (name: string): AgentDefinition =>
  AgentDefinition.make({
    name: AgentName.make(name),
    description: name,
    driver: ExternalDriverRef.make({ id: `acp-${name}` }),
  })

describe("resolveDualModelPair", () => {
  it.live("name-based: cowork + deepwork win when both present", () =>
    Effect.gen(function* () {
      const [a, b] = yield* resolveDualModelPair([
        agent("explore", "anthropic/claude-haiku-4"),
        agent("cowork", "anthropic/claude-opus-4-6"),
        agent("deepwork", "openai/gpt-5.4"),
      ])
      expect(a).toBe(ModelId.make("anthropic/claude-opus-4-6"))
      expect(b).toBe(ModelId.make("openai/gpt-5.4"))
    }),
  )

  it.live("positional fallback: first two modeled agents when no cowork/deepwork", () =>
    Effect.gen(function* () {
      const [a, b] = yield* resolveDualModelPair([
        agent("planner", "anthropic/claude-haiku-4"),
        externalAgent("claude-code"),
        agent("reviewer", "openai/gpt-5.4"),
      ])
      expect(a).toBe(ModelId.make("anthropic/claude-haiku-4"))
      expect(b).toBe(ModelId.make("openai/gpt-5.4"))
    }),
  )

  it.live("self-pair: single modeled agent maps to itself", () =>
    Effect.gen(function* () {
      const [a, b] = yield* resolveDualModelPair([agent("only", "anthropic/claude-haiku-4")])
      expect(a).toBe(ModelId.make("anthropic/claude-haiku-4"))
      expect(b).toBe(ModelId.make("anthropic/claude-haiku-4"))
    }),
  )

  it.live("fails with NoModeledAgentsError when no modeled agents exist", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(resolveDualModelPair([externalAgent("claude-code")]))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(NoModeledAgentsError)(error.value)).toBe(true)
    }),
  )

  it.live("fails when given an empty agent list", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(resolveDualModelPair([]))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
