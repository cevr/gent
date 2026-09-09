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
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentsViewExtension, ListAgents } from "../../src/agents-view/index.js"
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
    }),
  ),
})

const listAgents = (input: { readonly query?: string }) =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
    const { client, sessionId, branchId } = yield* createRpcHarness({
      ...e2ePreset,
      providerLayer,
      extensionInputs: [AgentsViewExtension],
      cwd: "/tmp/agents-view-rpc",
    })
    const raw = yield* client.extension.request({
      sessionId,
      branchId,
      extensionId: ref(ListAgents).extensionId,
      capabilityId: ref(ListAgents).capabilityId,
      input,
    })
    const reply = yield* Schema.decodeUnknownEffect(ReplySchema)(raw)
    return { reply, sessionId, branchId }
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
