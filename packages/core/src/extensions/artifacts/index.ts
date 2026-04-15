/**
 * Artifacts extension — generic artifact store with typed protocol.
 *
 * Any tool/extension can store artifacts via ctx.extension.ask(ArtifactProtocol.Save(...)).
 * Artifacts are branch-aware, persist across turns, and project compact summaries
 * into the system prompt.
 *
 * Actor state: { items: Artifact[] }
 * Upsert: by sourceTool + branchId (last-writer-wins per source per branch)
 */

import { Effect, Schema } from "effect"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import type {
  ExtensionActorDefinition,
  ExtensionTurnContext,
  TurnProjection,
} from "../../domain/extension.js"
import type { PromptSection } from "../../domain/prompt.js"
import { ArtifactId } from "../../domain/ids.js"
import type { BranchId } from "../../domain/ids.js"
import { defineTool, type ToolContext } from "../../domain/tool.js"
import { extension } from "../api.js"
import {
  ARTIFACTS_EXTENSION_ID,
  ArtifactProtocol,
  type Artifact,
  type ArtifactUiModel,
  type ContentPatch,
  ArtifactUiModel as ArtifactUiModelSchema,
  Artifact as ArtifactSchema,
} from "../artifacts-protocol.js"

export { ARTIFACTS_EXTENSION_ID } from "../artifacts-protocol.js"

// ── Helpers ──

const generateId = () => ArtifactId.of(crypto.randomUUID())

const applyPatch = (content: string, patch: ContentPatch): string =>
  patch.replaceAll === true
    ? content.replaceAll(patch.find, patch.replace)
    : content.replace(patch.find, patch.replace)

// ── Machine state + events ──

const ArtifactsMachineState = MState({
  Active: {
    items: Schema.Array(ArtifactSchema),
  },
})

const ArtifactsMachineEvent = MEvent({
  Save: MEvent.reply(
    {
      label: Schema.String,
      sourceTool: Schema.String,
      content: Schema.String,
      path: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      branchId: Schema.optional(Schema.String),
    },
    ArtifactSchema,
  ),
  Read: MEvent.reply(
    {
      query: Schema.Unknown,
    },
    Schema.NullOr(ArtifactSchema),
  ),
  Update: MEvent.reply(
    {
      id: Schema.String,
      patch: Schema.optional(Schema.Unknown),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      status: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String),
    },
    Schema.NullOr(ArtifactSchema),
  ),
  Clear: MEvent.reply(
    {
      id: Schema.String,
    },
    Schema.Void,
  ),
  List: MEvent.reply(
    {
      branchId: Schema.optional(Schema.String),
    },
    Schema.Array(ArtifactSchema),
  ),
})

// ── Machine ──

const artifactsMachine = Machine.make({
  state: ArtifactsMachineState,
  event: ArtifactsMachineEvent,
  initial: ArtifactsMachineState.Active({ items: [] }),
})
  .on(ArtifactsMachineState.Active, ArtifactsMachineEvent.Save, ({ state, event }) => {
    const now = Date.now()
    const existingIdx = state.items.findIndex(
      (a) =>
        a.sourceTool === event.sourceTool &&
        a.branchId === (event.branchId as BranchId | undefined),
    )
    const existing = existingIdx >= 0 ? state.items[existingIdx] : undefined
    const artifact: Artifact = {
      id: existing?.id ?? generateId(),
      label: event.label,
      sourceTool: event.sourceTool,
      content: event.content,
      path: event.path,
      status: "active",
      metadata: event.metadata,
      branchId: event.branchId as BranchId | undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const items =
      existingIdx >= 0
        ? state.items.map((a, i) => (i === existingIdx ? artifact : a))
        : [...state.items, artifact]
    return Machine.reply(ArtifactsMachineState.Active({ items }), artifact)
  })
  .on(ArtifactsMachineState.Active, ArtifactsMachineEvent.Read, ({ state, event }) => {
    const query = event.query as {
      _tag: string
      id?: string
      sourceTool?: string
      branchId?: string
    }
    let found: Artifact | undefined
    if (query._tag === "ById") {
      found = state.items.find((a) => a.id === query.id)
    } else if (query._tag === "BySource") {
      const bySource = state.items.filter((a) => a.sourceTool === query.sourceTool)
      // Prefer exact branch match, fall back to session-wide (branchId === undefined)
      found =
        query.branchId !== undefined
          ? (bySource.find((a) => a.branchId === query.branchId) ??
            bySource.find((a) => a.branchId === undefined))
          : bySource.find((a) => a.branchId === undefined)
    }
    return Machine.reply(ArtifactsMachineState.Active({ items: state.items }), found ?? null)
  })
  .on(ArtifactsMachineState.Active, ArtifactsMachineEvent.Update, ({ state, event }) => {
    const idx = state.items.findIndex((a) => a.id === event.id)
    if (idx < 0) {
      return Machine.reply(ArtifactsMachineState.Active({ items: state.items }), null)
    }
    const existing = state.items[idx]
    if (existing === undefined) {
      return Machine.reply(ArtifactsMachineState.Active({ items: state.items }), null)
    }
    const updated: Artifact = {
      ...existing,
      content:
        event.patch !== undefined
          ? applyPatch(existing.content, event.patch as ContentPatch)
          : existing.content,
      metadata: event.metadata !== undefined ? event.metadata : existing.metadata,
      status: event.status !== undefined ? (event.status as Artifact["status"]) : existing.status,
      label: event.label !== undefined ? event.label : existing.label,
      updatedAt: Date.now(),
    }
    const items = state.items.map((a, i) => (i === idx ? updated : a))
    return Machine.reply(ArtifactsMachineState.Active({ items }), updated)
  })
  .on(ArtifactsMachineState.Active, ArtifactsMachineEvent.Clear, ({ state, event }) => {
    const items = state.items.filter((a) => a.id !== event.id)
    return Machine.reply(ArtifactsMachineState.Active({ items }), undefined)
  })
  .on(ArtifactsMachineState.Active, ArtifactsMachineEvent.List, ({ state, event }) => {
    const filtered =
      event.branchId !== undefined
        ? state.items.filter((a) => a.branchId === undefined || a.branchId === event.branchId)
        : state.items
    return Machine.reply(ArtifactsMachineState.Active({ items: state.items }), filtered)
  })

// ── Prompt projection ──

const projectTurn = (
  state: typeof ArtifactsMachineState.Type,
  ctx: ExtensionTurnContext,
): TurnProjection => {
  const items = state.items.filter(
    (a) => a.status === "active" && (a.branchId === undefined || a.branchId === ctx.branchId),
  )
  if (items.length === 0) return {}

  const lines = items.map((a) => {
    const path = a.path !== undefined ? ` (${a.path})` : ""
    return `- **${a.label}** [${a.sourceTool}]${path}`
  })

  const section: PromptSection = {
    id: "active-artifacts",
    content: `## Active Artifacts\n\n${lines.join("\n")}\n\nUse the \`artifact_read\` tool to view full content.`,
    priority: 92,
  }

  return { promptSections: [section] }
}

// ── UI snapshot ──

const projectSnapshot = (state: typeof ArtifactsMachineState.Type): ArtifactUiModel => ({
  items: state.items.map((a) => ({
    id: a.id,
    label: a.label,
    sourceTool: a.sourceTool,
    status: a.status,
    path: a.path,
    branchId: a.branchId,
    createdAt: a.createdAt,
  })),
})

// ── Actor ──

const artifactsActor: ExtensionActorDefinition<
  typeof ArtifactsMachineState.Type,
  typeof ArtifactsMachineEvent.Type
> = {
  machine: artifactsMachine,
  mapRequest: (message) => {
    if (message.extensionId !== ARTIFACTS_EXTENSION_ID) return undefined
    switch (message._tag) {
      case "Save": {
        const m = message as ReturnType<typeof ArtifactProtocol.Save>
        return ArtifactsMachineEvent.Save(m)
      }
      case "Read": {
        const m = message as ReturnType<typeof ArtifactProtocol.Read>
        return ArtifactsMachineEvent.Read({ query: m.query })
      }
      case "Update": {
        const m = message as ReturnType<typeof ArtifactProtocol.Update>
        return ArtifactsMachineEvent.Update(m)
      }
      case "Clear": {
        const m = message as ReturnType<typeof ArtifactProtocol.Clear>
        return ArtifactsMachineEvent.Clear(m)
      }
      case "List": {
        const m = message as ReturnType<typeof ArtifactProtocol.List>
        return ArtifactsMachineEvent.List(m)
      }
    }
  },
  snapshot: {
    schema: ArtifactUiModelSchema,
    project: projectSnapshot,
  },
  turn: {
    project: projectTurn,
  },
  stateSchema: ArtifactsMachineState,
  protocols: ArtifactProtocol,
}

// ── Agent-facing tools ──

const ArtifactSaveTool = defineTool({
  name: "artifact_save",
  concurrency: "parallel" as const,
  description:
    "Save an artifact (plan, audit report, review, or any structured result). Upserts by sourceTool + branch.",
  params: Schema.Struct({
    label: Schema.String.annotate({ description: "Short label for display" }),
    sourceTool: Schema.String.annotate({ description: "Tool that produced this artifact" }),
    content: Schema.String.annotate({ description: "Full artifact content" }),
    path: Schema.optional(Schema.String.annotate({ description: "File path if saved to disk" })),
    metadata: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Tool-specific structured data",
      }),
    ),
  }),
  execute: Effect.fn("ArtifactSaveTool.execute")(function* (params, ctx: ToolContext) {
    const artifact = yield* ctx.extension.ask(
      ArtifactProtocol.Save({
        ...params,
        branchId: ctx.branchId,
      }),
      ctx.branchId,
    )
    return { id: artifact.id, label: artifact.label, sourceTool: artifact.sourceTool }
  }),
})

const ArtifactReadTool = defineTool({
  name: "artifact_read",
  concurrency: "parallel" as const,
  description: "Read the full content of an artifact by label/source or ID.",
  params: Schema.Struct({
    id: Schema.optional(Schema.String.annotate({ description: "Artifact ID (if known)" })),
    sourceTool: Schema.optional(
      Schema.String.annotate({ description: "Source tool name to look up by" }),
    ),
  }),
  execute: Effect.fn("ArtifactReadTool.execute")(function* (params, ctx: ToolContext) {
    const query =
      params.id !== undefined
        ? { _tag: "ById" as const, id: ArtifactId.of(params.id) }
        : { _tag: "BySource" as const, sourceTool: params.sourceTool ?? "", branchId: ctx.branchId }
    const artifact = yield* ctx.extension.ask(ArtifactProtocol.Read({ query }), ctx.branchId)
    if (artifact === null) return { found: false }
    return { found: true, ...artifact }
  }),
})

const ArtifactUpdateTool = defineTool({
  name: "artifact_update",
  concurrency: "serial" as const,
  description:
    "Update an existing artifact. Supports content patches (find/replace), metadata updates, status changes, and label renames.",
  params: Schema.Struct({
    id: Schema.String.annotate({ description: "Artifact ID to update" }),
    find: Schema.optional(Schema.String.annotate({ description: "Text to find in content" })),
    replace: Schema.optional(Schema.String.annotate({ description: "Replacement text" })),
    replaceAll: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace all occurrences (default: first only)" }),
    ),
    status: Schema.optional(
      Schema.Literals(["active", "resolved"]).annotate({ description: "New status" }),
    ),
    label: Schema.optional(Schema.String.annotate({ description: "New label" })),
    metadata: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "New metadata (replaces existing)",
      }),
    ),
  }),
  execute: Effect.fn("ArtifactUpdateTool.execute")(function* (params, ctx: ToolContext) {
    const patch =
      params.find !== undefined && params.replace !== undefined
        ? { find: params.find, replace: params.replace, replaceAll: params.replaceAll }
        : undefined
    const artifact = yield* ctx.extension.ask(
      ArtifactProtocol.Update({
        id: ArtifactId.of(params.id),
        patch,
        status: params.status,
        label: params.label,
        metadata: params.metadata,
      }),
      ctx.branchId,
    )
    if (artifact === null) return { found: false }
    return { found: true, id: artifact.id, label: artifact.label, status: artifact.status }
  }),
})

const ArtifactClearTool = defineTool({
  name: "artifact_clear",
  concurrency: "parallel" as const,
  description: "Remove an artifact by ID.",
  params: Schema.Struct({
    id: Schema.String.annotate({ description: "Artifact ID to remove" }),
  }),
  execute: Effect.fn("ArtifactClearTool.execute")(function* (params, ctx: ToolContext) {
    yield* ctx.extension.ask(ArtifactProtocol.Clear({ id: ArtifactId.of(params.id) }), ctx.branchId)
    return { cleared: true }
  }),
})

// ── Extension ──

export const ArtifactsExtension = extension(ARTIFACTS_EXTENSION_ID, ({ ext }) =>
  ext
    .actor(artifactsActor)
    .tools(ArtifactSaveTool, ArtifactReadTool, ArtifactUpdateTool, ArtifactClearTool),
)
