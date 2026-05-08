import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { DelegateTool } from "../../src/delegate/delegate-tool.js"
import { AgentName } from "@gent/core-internal/domain/agent"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"
import { layer, makeCtx, narrowR, setup, withTaskWrite } from "../task-tools/helpers.js"

describe("DelegateTool background mode", () => {
  it.live("returns running status via background param", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(DelegateTool)(
          {
            agent: AgentName.make("explore"),
            task: "analyze the codebase",
            background: true,
          },
          ctx,
        )
        if (!("taskId" in result) || result.taskId === undefined) {
          throw new Error("expected background delegate task")
        }
        expect(result.taskId).toBeDefined()
        expect(result.status).toBe("running")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})
