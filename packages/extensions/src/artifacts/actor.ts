/**
 * Artifacts actor — durable artifact store hosted on a `Behavior`.
 *
 * Messages share `_tag` strings with `ArtifactProtocol.*` envelopes so
 * the actor-route fallback in MachineEngine forwards
 * `runtime.execute(ArtifactProtocol.X.make(...))` straight into the
 * actor mailbox and threads the reply back through the ask correlation.
 *
 * State: `{ items: ReadonlyArray<Artifact> }`. Save upserts by
 * `(sourceTool, branchId)` so each tool surface owns one slot per
 * branch. No persistence: artifacts are session-scoped and rebuilt on
 * resume from the events that produced them.
 */

import { Effect, Schema } from "effect"
import {
  ArtifactId,
  BranchId,
  behavior,
  ServiceKey,
  TaggedEnumClass,
  type Behavior,
} from "@gent/core/extensions/api"
import { ArtifactStatus, ContentPatch, ReadQuery, type Artifact } from "../artifacts-protocol.js"

// ── Helpers ──

const generateId = () => ArtifactId.make(crypto.randomUUID())

const applyPatch = (content: string, patch: typeof ContentPatch.Type): string =>
  patch.replaceAll === true
    ? content.replaceAll(patch.find, patch.replace)
    : content.replace(patch.find, patch.replace)

// ── Messages ──
//
// `_tag` strings match `ArtifactProtocol.*` so the actor-route fallback
// forwards envelopes directly. Each Save/Read/Update/Clear/List call
// `ctx.reply`s the typed result.

export const ArtifactsMsg = TaggedEnumClass("ArtifactsMsg", {
  Save: {
    label: Schema.String,
    sourceTool: Schema.String,
    content: Schema.String,
    path: Schema.optional(Schema.String),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    branchId: Schema.optional(BranchId),
  },
  Read: { query: ReadQuery },
  Update: {
    id: ArtifactId,
    patch: Schema.optional(ContentPatch),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    status: Schema.optional(ArtifactStatus),
    label: Schema.optional(Schema.String),
  },
  Clear: { id: ArtifactId },
  List: { branchId: Schema.optional(BranchId) },
})
export type ArtifactsMsg = Schema.Schema.Type<typeof ArtifactsMsg>

interface ArtifactsState {
  readonly items: ReadonlyArray<Artifact>
}

export const ArtifactsService = ServiceKey<ArtifactsMsg>("@gent/artifacts/store")

// ── Pure handlers ──

const handleSave = (
  state: ArtifactsState,
  msg: Extract<ArtifactsMsg, { _tag: "Save" }>,
): { state: ArtifactsState; reply: Artifact } => {
  const now = Date.now()
  const existingIdx = state.items.findIndex(
    (a) => a.sourceTool === msg.sourceTool && a.branchId === msg.branchId,
  )
  const existing = existingIdx >= 0 ? state.items[existingIdx] : undefined
  const artifact: Artifact = {
    id: existing?.id ?? generateId(),
    label: msg.label,
    sourceTool: msg.sourceTool,
    content: msg.content,
    path: msg.path,
    status: "active",
    metadata: msg.metadata,
    branchId: msg.branchId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const items =
    existingIdx >= 0
      ? state.items.map((a, i) => (i === existingIdx ? artifact : a))
      : [...state.items, artifact]
  return { state: { items }, reply: artifact }
}

const handleRead = (
  state: ArtifactsState,
  msg: Extract<ArtifactsMsg, { _tag: "Read" }>,
): Artifact | null => {
  const { query } = msg
  if (query._tag === "ById") {
    return state.items.find((a) => a.id === query.id) ?? null
  }
  const bySource = state.items.filter((a) => a.sourceTool === query.sourceTool)
  const found =
    query.branchId !== undefined
      ? (bySource.find((a) => a.branchId === query.branchId) ??
        bySource.find((a) => a.branchId === undefined))
      : bySource.find((a) => a.branchId === undefined)
  return found ?? null
}

const handleUpdate = (
  state: ArtifactsState,
  msg: Extract<ArtifactsMsg, { _tag: "Update" }>,
): { state: ArtifactsState; reply: Artifact | null } => {
  const idx = state.items.findIndex((a) => a.id === msg.id)
  const existing = idx >= 0 ? state.items[idx] : undefined
  if (existing === undefined) return { state, reply: null }
  const updated: Artifact = {
    ...existing,
    content: msg.patch !== undefined ? applyPatch(existing.content, msg.patch) : existing.content,
    metadata: msg.metadata !== undefined ? msg.metadata : existing.metadata,
    status: msg.status !== undefined ? msg.status : existing.status,
    label: msg.label !== undefined ? msg.label : existing.label,
    updatedAt: Date.now(),
  }
  const items = state.items.map((a, i) => (i === idx ? updated : a))
  return { state: { items }, reply: updated }
}

const handleList = (
  state: ArtifactsState,
  msg: Extract<ArtifactsMsg, { _tag: "List" }>,
): ReadonlyArray<Artifact> =>
  msg.branchId !== undefined
    ? state.items.filter((a) => a.branchId === undefined || a.branchId === msg.branchId)
    : state.items

// ── Behavior ──

const artifactsBehavior: Behavior<ArtifactsMsg, ArtifactsState, never> = {
  initialState: { items: [] },
  serviceKey: ArtifactsService,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Save": {
          const result = handleSave(state, msg)
          yield* ctx.reply(result.reply)
          return result.state
        }
        case "Read":
          yield* ctx.reply(handleRead(state, msg))
          return state
        case "Update": {
          const result = handleUpdate(state, msg)
          yield* ctx.reply(result.reply)
          return result.state
        }
        case "Clear": {
          const items = state.items.filter((a) => a.id !== msg.id)
          yield* ctx.reply(undefined)
          return { items }
        }
        case "List":
          yield* ctx.reply(handleList(state, msg))
          return state
      }
    }),
}

export const artifactsActor = behavior(artifactsBehavior)
