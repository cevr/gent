import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { runLoop, type LoopVerdict } from "@gent/core/runtime/loop"
import type { SubagentResult, SubagentError } from "@gent/core/domain/agent"

describe("runLoop", () => {
  const makeSuccess = (text: string): SubagentResult => ({
    _tag: "success",
    text,
    sessionId: "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
      ? S
      : never,
    agentName: "explore" as SubagentResult & { _tag: "success" } extends { agentName: infer A }
      ? A
      : never,
  })

  const makeError = (error: string): SubagentResult => ({
    _tag: "error",
    error,
  })

  it.live("runs body and evaluator each iteration", () => {
    let bodyCount = 0
    let evalCount = 0

    return runLoop({
      maxIterations: 3,
      body: (iteration) => {
        bodyCount++
        return Effect.succeed(makeSuccess(`output-${iteration}`))
      },
      evaluate: () => {
        evalCount++
        return Effect.succeed("continue" as LoopVerdict)
      },
    }).pipe(
      Effect.map((result) => {
        expect(bodyCount).toBe(3)
        expect(evalCount).toBe(3)
        expect(result.iterations).toBe(3)
        expect(result.reason).toBe("max_reached")
        expect(result.output).toBe("output-3")
      }),
    )
  })

  it.live("stops early when evaluator returns done", () =>
    runLoop({
      maxIterations: 10,
      body: (iteration) => Effect.succeed(makeSuccess(`output-${iteration}`)),
      evaluate: (iteration) =>
        Effect.succeed((iteration >= 2 ? "done" : "continue") as LoopVerdict),
    }).pipe(
      Effect.map((result) => {
        expect(result.iterations).toBe(2)
        expect(result.reason).toBe("done")
        expect(result.output).toBe("output-2")
      }),
    ),
  )

  it.live("stops on body error", () =>
    runLoop({
      maxIterations: 5,
      body: (iteration) =>
        iteration === 3
          ? Effect.succeed(makeError("boom"))
          : Effect.succeed(makeSuccess(`ok-${iteration}`)),
      evaluate: () => Effect.succeed("continue" as LoopVerdict),
    }).pipe(
      Effect.map((result) => {
        expect(result.iterations).toBe(3)
        expect(result.reason).toBe("error")
        expect(result.error).toBe("boom")
        expect(result.output).toBe("ok-2")
      }),
    ),
  )

  it.live("passes previous output to body", () => {
    const received: string[] = []

    return runLoop({
      maxIterations: 3,
      body: (_iteration, previousOutput) => {
        received.push(previousOutput)
        return Effect.succeed(makeSuccess(`iter-${_iteration}`))
      },
      evaluate: () => Effect.succeed("continue" as LoopVerdict),
    }).pipe(
      Effect.map(() => {
        expect(received[0]).toBe("")
        expect(received[1]).toBe("iter-1")
        expect(received[2]).toBe("iter-2")
      }),
    )
  })

  it.live("calls onIteration for each phase", () => {
    const phases: Array<{ iteration: number; phase: string }> = []

    return runLoop({
      maxIterations: 2,
      body: (i) => Effect.succeed(makeSuccess(`out-${i}`)),
      evaluate: (i) => Effect.succeed((i >= 2 ? "done" : "continue") as LoopVerdict),
      onIteration: (iteration, phase) => {
        phases.push({ iteration, phase })
        return Effect.void as Effect.Effect<void, SubagentError>
      },
    }).pipe(
      Effect.map(() => {
        expect(phases).toEqual([
          { iteration: 1, phase: "body" },
          { iteration: 1, phase: "evaluate" },
          { iteration: 2, phase: "body" },
          { iteration: 2, phase: "evaluate" },
        ])
      }),
    )
  })

  it.live("single iteration with immediate done", () =>
    runLoop({
      maxIterations: 5,
      body: () => Effect.succeed(makeSuccess("first")),
      evaluate: () => Effect.succeed("done" as LoopVerdict),
    }).pipe(
      Effect.map((result) => {
        expect(result.iterations).toBe(1)
        expect(result.reason).toBe("done")
        expect(result.output).toBe("first")
      }),
    ),
  )

  it.live("passes evaluator feedback into the next body iteration", () => {
    const receivedFeedback: Array<string | undefined> = []

    return runLoop({
      maxIterations: 2,
      body: (_iteration, _previousOutput, evaluatorFeedback) => {
        receivedFeedback.push(evaluatorFeedback)
        return Effect.succeed(makeSuccess(`out-${_iteration}`))
      },
      evaluate: (iteration) =>
        Effect.succeed(
          iteration === 1
            ? { verdict: "continue" as const, feedback: "fix remaining issue" }
            : { verdict: "done" as const, feedback: "complete" },
        ),
    }).pipe(
      Effect.map(() => {
        expect(receivedFeedback).toEqual([undefined, "fix remaining issue"])
      }),
    )
  })
})
