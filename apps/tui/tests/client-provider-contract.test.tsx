/** @jsxImportSource @opentui/solid */
/**
 * The merged client provider's contract.
 *
 * `ClientProvider` used to publish four Solid contexts — transport, session,
 * agent, actions — and every consumer spread them back into one object. That
 * split had two observable costs, and each test below fails if it returns:
 *
 * 1. Two consumers read two different objects, so a value could not be
 *    compared or passed across the seam without re-merging it.
 * 2. A merged object captured before a write kept serving the value from the
 *    merge, so a consumer that held one observed a stale session while a
 *    consumer that re-read observed the new one.
 */
import { describe, it, expect } from "effect-bun-test"
import { BranchId, SessionId } from "@gent/core/protocol"
import { onMount } from "solid-js"
import { Effect, Option, Schema } from "effect"
import { renderWithProviders } from "./render-harness-boundary"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"

class ClientProviderContractError extends Schema.TaggedError<ClientProviderContractError>()(
  "ClientProviderContractError",
  { message: Schema.String },
) {}

const requireValue = <A,>(
  value: Option.Option<A>,
  message: string,
): Effect.Effect<A, ClientProviderContractError> => {
  if (Option.isNone(value)) return Effect.fail(new ClientProviderContractError({ message }))
  return Effect.succeed(value.value)
}

function Probe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

const settle = (setup: Awaited<ReturnType<typeof renderWithProviders>>) =>
  Effect.promise(() => setup.renderOnce())

describe("ClientProvider contract", () => {
  it.live("two consumers read one value, not one merge each", () =>
    Effect.gen(function* () {
      let first = Option.none<ClientContextValue>()
      let second = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <box>
            <Probe onReady={(value) => (first = Option.some(value))} />
            <Probe onReady={(value) => (second = Option.some(value))} />
          </box>
        )),
      )
      yield* settle(setup)

      const a = yield* requireValue(first, "first consumer never mounted")
      const b = yield* requireValue(second, "second consumer never mounted")

      // A spread per hook call would hand each consumer its own object.
      expect(a).toBe(b)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("a value held across a write reports the write, never the merge", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe onReady={(value) => (held = Option.some(value))} />),
      )
      yield* settle(setup)

      // Captured before the write. The old split let this object keep the
      // session accessor from one context and the agent accessor from
      // another, so a consumer that stored it could observe a session the
      // rest of the tree had already left.
      const captured = yield* requireValue(held, "consumer never mounted")
      expect(Option.fromNullishOr(captured.session())).toEqual(Option.none())

      const sessionId = SessionId.make("contract-session")
      const branchId = BranchId.make("contract-branch")
      captured.switchSession(sessionId, branchId, "Contract")
      yield* settle(setup)

      const observed = yield* requireValue(
        Option.fromNullishOr(captured.session()),
        "held value never observed the switch",
      )
      expect(observed.sessionId).toBe(sessionId)
      expect(observed.branchId).toBe(branchId)
      expect(captured.isActive()).toBe(true)
      expect(captured.sessionState().status).toBe("active")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("one value carries every facet the consumers used to merge", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe onReady={(value) => (held = Option.some(value))} />),
      )
      yield* settle(setup)

      const client = yield* requireValue(held, "consumer never mounted")

      // Transport, session, agent and actions — all exercised through one
      // read. Four contexts forced a consumer that needed two facets to
      // merge them; this one value answers for every facet at once.
      let seen = 0
      const unsubscribe = client.onSessionEvent(() => {
        seen = seen + 1
      })
      expect(client.connectionGeneration()).toBe(0)
      expect(client.isActive()).toBe(false)
      expect(client.agentStatus()._tag).toBe("Idle")
      expect(client.isStreaming()).toBe(false)

      // An action writes; the agent facet on the same value reports it.
      client.setError("contract failure")
      expect(client.isError()).toBe(true)
      expect(client.error()).toBe("contract failure")

      // A session write; the session facet on the same value reports it.
      client.switchSession(SessionId.make("facet-session"), BranchId.make("facet-branch"), "Facets")
      yield* settle(setup)
      expect(client.isActive()).toBe(true)
      // switchSession also resets the agent facet, from the same value.
      expect(client.agentStatus()._tag).toBe("Idle")
      expect(client.cost()).toBe(0)

      unsubscribe()
      expect(seen).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
})
