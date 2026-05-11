import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { DelegateTool } from "../../src/delegate/delegate-tool.js"
import { AgentName } from "@gent/core-internal/domain/agent"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { layer, makeCtx, narrowR, setup, withTodoWrite } from "../todo/helpers.js"

describe("DelegateTool background mode", () => {
  it.live("returns running status via background param", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* runToolWithCtx(
          DelegateTool,
          {
            agent: AgentName.make("explore"),
            todo: "analyze the codebase",
            background: true,
          },
          ctx,
        )
        if (!("todoId" in result) || result.todoId === undefined) {
          throw new Error("expected background delegate todo")
        }
        expect(result.todoId).toBeDefined()
        expect(result.status).toBe("running")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})
