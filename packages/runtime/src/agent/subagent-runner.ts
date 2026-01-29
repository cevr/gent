import { Cause, Effect, Layer } from "effect"
import {
  Branch,
  EventStore,
  Session,
  SubagentCompleted,
  SubagentError,
  SubagentRunnerService,
  SubagentSpawned,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { AgentActor } from "./agent-actor"
import { SubagentRunnerConfig } from "./subagent-runner-config"

export const InProcessRunner: Layer.Layer<
  SubagentRunnerService,
  never,
  Storage | EventStore | AgentActor | SubagentRunnerConfig
> = Layer.effect(
  SubagentRunnerService,
  Effect.gen(function* () {
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const actor = yield* AgentActor
    const runnerConfig = yield* SubagentRunnerConfig

    return {
      run: (params) => {
        const sessionId = Bun.randomUUIDv7()
        const branchId = Bun.randomUUIDv7()
        const now = new Date()

        return Effect.gen(function* () {
          const parentSession = yield* storage.getSession(params.parentSessionId)
          const bypass = parentSession?.bypass ?? true

          const session = new Session({
            id: sessionId,
            name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
            cwd: params.cwd,
            bypass,
            parentSessionId: params.parentSessionId,
            parentBranchId: params.parentBranchId,
            createdAt: now,
            updatedAt: now,
          })

          const branch = new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          })

          yield* storage.createSession(session)
          yield* storage.createBranch(branch)

          yield* eventStore.publish(
            new SubagentSpawned({
              parentSessionId: params.parentSessionId,
              childSessionId: sessionId,
              agentName: params.agent.name,
              prompt: params.prompt,
            }),
          )

          yield* actor.run({
            sessionId,
            branchId,
            agentName: params.agent.name,
            prompt: params.prompt,
            defaultModel: runnerConfig.defaultModel,
            systemPrompt: runnerConfig.systemPrompt,
            bypass,
          })

          const messages = yield* storage.listMessages(branchId)
          let text = ""
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (msg === undefined || msg.role !== "assistant") continue
            const part = msg.parts.find((p) => p.type === "text")
            text = part?.text ?? ""
            break
          }

          yield* eventStore.publish(
            new SubagentCompleted({
              parentSessionId: params.parentSessionId,
              childSessionId: sessionId,
              agentName: params.agent.name,
              success: true,
            }),
          )

          return { _tag: "success" as const, text, sessionId, agentName: params.agent.name }
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const error = Cause.pretty(cause)
              yield* eventStore
                .publish(
                  new SubagentCompleted({
                    parentSessionId: params.parentSessionId,
                    childSessionId: sessionId,
                    agentName: params.agent.name,
                    success: false,
                  }),
                )
                .pipe(Effect.catchAll(() => Effect.void))

              return {
                _tag: "error" as const,
                error,
                sessionId,
                agentName: params.agent.name,
              }
            }),
          ),
        )
      },
    }
  }),
)

export const SubprocessRunner: Layer.Layer<SubagentRunnerService, never, SubagentRunnerConfig> =
  Layer.effect(
    SubagentRunnerService,
    Effect.gen(function* () {
      const config = yield* SubagentRunnerConfig
      return {
        run: () =>
          Effect.fail(
            new SubagentError({
              message: `Subprocess runner not implemented (binary: ${
                config.subprocessBinaryPath ?? "gent"
              })`,
            }),
          ),
      }
    }),
  )
