/**
 * Agents view — the server half.
 *
 * Per the third rule, the view is an extension of the loop, not core code and
 * not app code. This half contributes one `request` capability returning the
 * reconciled agent rows; the client half renders them.
 *
 * The reconciliation itself lives in `./projection.js` as pure functions, so
 * the correctness is tested without a terminal or a runtime.
 *
 * @module
 */

import { Effect, Option, Schema } from "effect"
import {
  BranchId,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  request,
  SessionId,
} from "@gent/core/extensions/api"
import { projectAgentRows, type DurableAgentRow, type LiveAgentRow } from "./projection.js"

/** Wire shape for one row. Options are flattened to optional keys for transport. */
const AgentRowSchema = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  section: Schema.Literals(["running", "idle", "inactive"]),
  agent: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  turns: Schema.optional(Schema.Finite),
  costUsd: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.Finite),
  live: Schema.Boolean,
  depth: Schema.Finite,
})

const ListAgentsInput = Schema.Struct({
  /** Case-insensitive substring filter over name, agent, cwd, model, and ids. */
  query: Schema.optional(Schema.String),
})

const ListAgentsOutput = Schema.Struct({
  rows: Schema.Array(AgentRowSchema),
})

export const LIST_AGENTS_ID = "list-agents"

/**
 * Join the live loop enumeration against durable session storage.
 *
 * Neither catalog is sufficient alone: the live one is empty after a restart,
 * and the durable one cannot say what is running. See `./projection.js`.
 */
const collectRows = Effect.fn("AgentsView.collectRows")(function* (query: string) {
  const ctx = yield* ExtensionContext

  // A catalog read that fails is a host defect, not something the caller can
  // recover from, so it dies rather than widening the capability's error type.
  const activeLoops = yield* ctx.Session.listActiveLoops.pipe(Effect.orDie)
  const sessions = yield* ctx.Session.listSessions.pipe(Effect.orDie)

  // The live half. Status and metrics need a per-loop read, which the row
  // capability deliberately does not do: enumerating N loops must not fan out
  // into N state reads on every keystroke. Rows carry identity and liveness;
  // the client subscribes per row for detail.
  const live: ReadonlyArray<LiveAgentRow> = activeLoops.map((loop) => ({
    sessionId: loop.sessionId,
    branchId: loop.branchId,
    agent: "main",
    status: "Running",
    model: Option.none(),
    turns: Option.none(),
    costUsd: Option.none(),
    durationMs: Option.none(),
  }))

  // The durable half. One row per session, keyed to its active branch — a
  // session with no active branch has never run and has no loop to show.
  const durable: ReadonlyArray<DurableAgentRow> = sessions.flatMap((session) => {
    const branchId = Option.fromUndefinedOr(session.activeBranchId)
    if (Option.isNone(branchId)) return []
    const parent = Option.all([
      Option.fromUndefinedOr(session.parentSessionId),
      Option.fromUndefinedOr(session.parentBranchId),
    ]).pipe(Option.map(([sessionId, parentBranchId]) => ({ sessionId, branchId: parentBranchId })))
    return [
      {
        sessionId: session.id,
        branchId: branchId.value,
        name: Option.fromUndefinedOr(session.name),
        cwd: Option.fromUndefinedOr(session.cwd),
        parent,
        updatedAt: session.updatedAt.getTime(),
      },
    ]
  })

  return projectAgentRows({ live, durable, query })
})

export const ListAgents = request({
  id: LIST_AGENTS_ID,
  input: ListAgentsInput,
  output: ListAgentsOutput,
  execute: Effect.fn("AgentsView.listAgents")(function* (input) {
    const rows = yield* collectRows(input.query ?? "")
    return {
      rows: rows.map((row) => ({
        sessionId: row.sessionId,
        branchId: row.branchId,
        section: row.section,
        agent: Option.getOrUndefined(row.agent),
        status: Option.getOrUndefined(row.status),
        name: Option.getOrUndefined(row.name),
        cwd: Option.getOrUndefined(row.cwd),
        model: Option.getOrUndefined(row.model),
        turns: Option.getOrUndefined(row.turns),
        costUsd: Option.getOrUndefined(row.costUsd),
        durationMs: Option.getOrUndefined(row.durationMs),
        updatedAt: Option.getOrUndefined(row.updatedAt),
        live: row.live,
        depth: row.depth,
      })),
    }
  }),
})

export const AgentsViewExtension = defineExtension({
  id: "@gent/agents-view",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", ListAgents)
  }),
})
