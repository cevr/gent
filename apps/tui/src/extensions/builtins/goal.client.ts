/**
 * Goal status label — transport-only.
 *
 * Reads the branch goal through `GoalRpc.Get` and refreshes on
 * `ExtensionStateChanged` pulses for `@gent/goal`. Renders one bottom-right
 * border label while a goal is pending on the current branch.
 */
import { Effect, Option } from "effect"
import { ref } from "@gent/core/extensions/api"
import { defineClientExtension, borderLabelContribution } from "../client-facets.js"
import {
  GoalRpc,
  GOAL_EXTENSION_ID,
  type GoalSnapshot,
  remainingTokens,
} from "@gent/extensions/client.js"
import { ClientTransport } from "../client-transport"
import { ClientLifecycle, ClientShell, makeClientSessionResource } from "../client-services"

export default defineClientExtension(GOAL_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const snapshot = yield* makeClientSessionResource<GoalSnapshot>({
      transport,
      lifecycle,
      cast: shell.cast,
      label: `${GOAL_EXTENSION_ID} goal`,
      fetch: (session) => transport.request(ref(GoalRpc.Get), {}, session),
      subscribe: (refetch) =>
        transport.onExtensionStateChanged((pulse) => {
          if (pulse.extensionId === GOAL_EXTENSION_ID) refetch()
        }),
    })

    return borderLabelContribution({
      position: "bottom-right",
      priority: 40,
      produce: () => {
        const goal = Option.fromNullishOr(snapshot.read()).pipe(
          Option.flatMap((value) => Option.fromUndefinedOr(value.goal)),
          Option.filter((value) => value.status !== "complete"),
        )
        if (Option.isNone(goal)) return []
        const parts = [`goal ${goal.value.status}`, `${goal.value.continuationsUsed}↻`]
        Option.map(remainingTokens(goal.value), (remaining) => {
          parts.push(`${remaining} left`)
        })
        let color: "info" | "warning" = "info"
        if (goal.value.status !== "active") color = "warning"
        return [{ text: parts.join(" · "), color }]
      },
    })
  }),
})
