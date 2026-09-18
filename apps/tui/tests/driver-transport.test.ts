/**
 * `/driver` routes through `ClientTransport.driverList/driverSet/driverClear`.
 *
 * The transport seals every shell RPC failure into a
 * `ClientTransportRequestError` that names the RPC and keeps the server's
 * tagged error as `cause`; the slash command reports that failure inline.
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Option, Schema } from "effect"
import { AgentName, BranchId, ModelDriverRef, SessionId } from "@gent/core/protocol"
import { AllBuiltinAgents } from "../../../packages/extensions/tests/helpers/builtin-agents.js"
import { builtinDriver } from "../src/extensions/builtins"
import { ClientTransport, makeClientTransportLayer } from "../src/extensions/client-facets"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"
import {
  makeClientTestTransport,
  runClientExtensionSetupWithRuntime,
} from "./extension-test-harness-boundary"

class DriverRejected extends Schema.TaggedError<DriverRejected>()("DriverRejected", {
  driverId: Schema.String,
}) {}

const absent = Option.getOrUndefined(Option.none())
const agentName = AgentName.make("main")
const session = { sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }

const driverListReply = {
  drivers: [{ _tag: "Model", id: "model:sonnet" }],
  overrides: {},
  agents: AllBuiltinAgents,
}

/** Run the `/driver` slash once and return the first message the shell receives. */
const runDriverSlash = (
  transport: ReturnType<typeof makeClientTestTransport>,
  args: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const message = yield* Deferred.make<string>()
    const contributions = yield* runClientExtensionSetupWithRuntime(builtinDriver, {
      transport,
      shell: {
        sendMessage: (content) => {
          Deferred.doneUnsafe(message, Effect.succeed(content))
        },
      },
    })
    const command = Option.fromUndefinedOr(contributions.commands).pipe(
      Option.flatMap((commands) => Option.fromUndefinedOr(commands[0])),
      Option.flatMap((entry) => Option.fromUndefinedOr(entry.onSlash)),
    )
    expect(Option.isSome(command)).toBe(true)
    if (Option.isSome(command)) command.value(args)
    return yield* Deferred.await(message)
  })

describe("driver routing through ClientTransport", () => {
  it.live(
    "driverSet keeps the server's tagged error as the cause of ClientTransportRequestError",
    () => {
      const rejected = new DriverRejected({ driverId: "model:nope" })
      const transport = makeClientTestTransport({ currentSession: () => absent })
      const client = createMockClient({ driver: { set: () => Effect.fail(rejected) } })
      const layer = makeClientTransportLayer({ ...transport, client, runtime: createMockRuntime() })
      return Effect.gen(function* () {
        const service = yield* ClientTransport
        const error = yield* service
          .driverSet({ agentName, driver: ModelDriverRef.make({ id: "model:nope" }) })
          .pipe(Effect.flip)
        expect(error._tag).toBe("ClientTransportRequestError")
        expect(error.tag).toBe("driver.set")
        const cause = Option.fromUndefinedOr(error.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toBe(rejected)
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("/driver <agent> <known-id> sets the override and confirms it", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly agentName: string; readonly driverId: string }> = []
      const client = createMockClient({
        driver: {
          list: () => Effect.succeed(driverListReply),
          set: (input: { agentName: AgentName; driver: { id: string } }) => {
            seen.push({ agentName: input.agentName, driverId: input.driver.id })
            return Effect.void
          },
        },
      })
      const transport = { ...makeClientTestTransport({ currentSession: () => session }), client }
      const message = yield* runDriverSlash(transport, "main model:sonnet").pipe(
        Effect.timeout("5 seconds"),
      )
      expect(message).toBe('Set "main" → driver "model:sonnet".')
      expect(seen).toEqual([{ agentName: "main", driverId: "model:sonnet" }])
    }),
  )

  it.live("/driver reports the transport error tag when driver.set is rejected", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        driver: {
          list: () => Effect.succeed(driverListReply),
          set: () => Effect.fail(new DriverRejected({ driverId: "model:sonnet" })),
        },
      })
      const transport = { ...makeClientTestTransport({ currentSession: () => session }), client }
      const message = yield* runDriverSlash(transport, "main model:sonnet").pipe(
        Effect.timeout("5 seconds"),
      )
      expect(message).toContain("Failed to set driver:")
      expect(message).toContain("ClientTransportRequestError")
      expect(message).toContain("DriverRejected")
    }),
  )

  it.live("/driver <agent> default clears the override", () =>
    Effect.gen(function* () {
      const cleared: Array<string> = []
      const client = createMockClient({
        driver: {
          clear: (input: { agentName: AgentName }) => {
            cleared.push(input.agentName)
            return Effect.void
          },
        },
      })
      const transport = { ...makeClientTestTransport({ currentSession: () => session }), client }
      const message = yield* runDriverSlash(transport, "main default").pipe(
        Effect.timeout("5 seconds"),
      )
      expect(message).toBe('Cleared driver override for "main".')
      expect(cleared).toEqual(["main"])
    }),
  )
})
