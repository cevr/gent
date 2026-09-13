/**
 * Agents view RPC acceptance — exercises AgentsViewExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 *
 * The projection itself is covered by pure tests in `projection.test.ts`. What
 * this file adds is the wiring: that `listSessions` and `listActiveLoops` reach
 * real host facets rather than their `unavailable` defaults. Both facets die
 * when unwired, so a passing assertion here is proof the seam is connected.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { ref } from "@gent/core/extensions/api"
import { textStep } from "@gent/core-internal/test-utils/sequence-steps"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentsViewExtension, AgentsViewRpc } from "../../src/agents-view/index.js"
import { e2ePreset } from "../helpers/test-preset"

const ReplySchema = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      branchId: Schema.String,
      section: Schema.String,
      name: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      live: Schema.Boolean,
      depth: Schema.Finite,
      parentSessionId: Schema.optional(Schema.String),
    }),
  ),
})

const openHarness = Effect.gen(function* () {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
  return yield* createRpcHarness({
    ...e2ePreset,
    providerLayer,
    extensionInputs: [AgentsViewExtension],
    cwd: "/tmp/agents-view-rpc",
  })
})

const listAgents = (input: { readonly query?: string }) =>
  Effect.gen(function* () {
    const harness = yield* openHarness
    const raw = yield* harness.client.extension.request({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
      extensionId: ref(AgentsViewRpc.ListAgents).extensionId,
      capabilityId: ref(AgentsViewRpc.ListAgents).capabilityId,
      input,
    })
    const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)
    return { reply, harness, sessionId: harness.sessionId, branchId: harness.branchId }
  })

describe("AgentsViewExtension via RPC", () => {
  it.live(
    "the harness session appears as a row with its stored cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply, sessionId } = yield* listAgents({})

          // Proves `listSessions` is wired: an unwired facet dies instead.
          const row = reply.rows.find((candidate) => candidate.sessionId === sessionId)
          expect(row).toBeDefined()
          expect(row!.cwd).toBe("/tmp/agents-view-rpc")
          // No parent link, so the session sits at the root of the tree.
          expect(row!.depth).toBe(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a query that matches nothing returns no rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply } = yield* listAgents({ query: "no-such-agent-anywhere" })
          expect(reply.rows).toHaveLength(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a child session nests under its parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* openHarness

          // `session.create` stores parentSessionId/parentBranchId, which is the
          // same link `delegate` writes for a subagent. Step 5's disclosure tree
          // reads nothing else, so proving depth here proves the nesting seam.
          const child = yield* harness.client.session.create({
            cwd: "/tmp/agents-view-rpc-child",
            parentSessionId: harness.sessionId,
            parentBranchId: harness.branchId,
          })

          const raw = yield* harness.client.extension.request({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
            extensionId: ref(AgentsViewRpc.ListAgents).extensionId,
            capabilityId: ref(AgentsViewRpc.ListAgents).capabilityId,
            input: {},
          })
          const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)

          const parentRow = reply.rows.find((row) => row.sessionId === harness.sessionId)
          const childRow = reply.rows.find((row) => row.sessionId === child.sessionId)
          expect(parentRow?.depth).toBe(0)
          expect(childRow?.depth).toBe(1)
          // The tray counts a session's subtree client-side, so the link travels.
          expect(parentRow?.parentSessionId).toBeUndefined()
          expect(childRow?.parentSessionId).toBe(harness.sessionId)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "the search filter keeps the session it matches",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reply, sessionId } = yield* listAgents({ query: "agents-view-rpc" })
          expect(reply.rows.map((row) => row.sessionId)).toContain(sessionId)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
