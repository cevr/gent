import { Context, Effect, Layer, Ref } from "effect"
import {
  ArtifactId,
  type BranchId,
  type ReadOnly,
  ReadOnlyBrand,
  type SessionId,
  withReadOnly,
} from "@gent/core/extensions/api"
import type { Artifact, ContentPatch, ReadQuery } from "../artifacts-protocol.js"

interface ArtifactsState {
  readonly sessions: Readonly<Record<SessionId, ReadonlyArray<Artifact>>>
}

export interface ArtifactSaveInput {
  readonly label: string
  readonly sourceTool: string
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly branchId?: BranchId
}

export interface ArtifactUpdateInput {
  readonly id: ArtifactId
  readonly patch?: ContentPatch
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly status?: Artifact["status"]
  readonly label?: string
}

interface ArtifactsReadShape {
  readonly read: (
    sessionId: SessionId,
    branchId: BranchId,
    query: ReadQuery,
  ) => Effect.Effect<Artifact | null>
  readonly list: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<Artifact>>
}

interface ArtifactsWriteShape extends ArtifactsReadShape {
  readonly save: (
    sessionId: SessionId,
    branchId: BranchId,
    input: ArtifactSaveInput,
  ) => Effect.Effect<Artifact>
  readonly update: (
    sessionId: SessionId,
    branchId: BranchId,
    input: ArtifactUpdateInput,
  ) => Effect.Effect<Artifact | null>
  readonly clear: (sessionId: SessionId, branchId: BranchId, id: ArtifactId) => Effect.Effect<void>
}

export class ArtifactsRead extends Context.Service<ArtifactsRead, ReadOnly<ArtifactsReadShape>>()(
  "@gent/extensions/artifacts/ArtifactsRead",
) {
  declare readonly [ReadOnlyBrand]: true
}

export class ArtifactsWrite extends Context.Service<ArtifactsWrite, ArtifactsWriteShape>()(
  "@gent/extensions/artifacts/ArtifactsWrite",
) {}

const generateId = () => ArtifactId.make(crypto.randomUUID())

const applyPatch = (content: string, patch: ContentPatch): string =>
  patch.replaceAll === true
    ? content.replaceAll(patch.find, patch.replace)
    : content.replace(patch.find, patch.replace)

const sessionItems = (state: ArtifactsState, sessionId: SessionId): ReadonlyArray<Artifact> =>
  state.sessions[sessionId] ?? []

const setSessionItems = (
  state: ArtifactsState,
  sessionId: SessionId,
  items: ReadonlyArray<Artifact>,
): ArtifactsState => ({ sessions: { ...state.sessions, [sessionId]: items } })

const readArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  query: ReadQuery,
): Artifact | null => {
  if (query._tag === "ById") {
    return items.find((a) => a.id === query.id && a.branchId === branchId) ?? null
  }
  return items.find((a) => a.sourceTool === query.sourceTool && a.branchId === branchId) ?? null
}

const listArtifacts = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
): ReadonlyArray<Artifact> => items.filter((a) => a.branchId === branchId)

const saveArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  input: ArtifactSaveInput,
): { readonly items: ReadonlyArray<Artifact>; readonly artifact: Artifact } => {
  const now = Date.now()
  const existingIdx = items.findIndex(
    (a) => a.sourceTool === input.sourceTool && a.branchId === branchId,
  )
  const existing = existingIdx >= 0 ? items[existingIdx] : undefined
  const artifact: Artifact = {
    id: existing?.id ?? generateId(),
    label: input.label,
    sourceTool: input.sourceTool,
    content: input.content,
    path: input.path,
    status: "active",
    metadata: input.metadata,
    branchId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const nextItems =
    existingIdx >= 0
      ? items.map((a, i) => (i === existingIdx ? artifact : a))
      : [...items, artifact]
  return { items: nextItems, artifact }
}

const updateArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  input: ArtifactUpdateInput,
): { readonly items: ReadonlyArray<Artifact>; readonly artifact: Artifact | null } => {
  const idx = items.findIndex((a) => a.id === input.id && a.branchId === branchId)
  const existing = idx >= 0 ? items[idx] : undefined
  if (existing === undefined) return { items, artifact: null }
  const artifact: Artifact = {
    ...existing,
    content:
      input.patch !== undefined ? applyPatch(existing.content, input.patch) : existing.content,
    metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
    status: input.status !== undefined ? input.status : existing.status,
    label: input.label !== undefined ? input.label : existing.label,
    updatedAt: Date.now(),
  }
  return {
    items: items.map((a, i) => (i === idx ? artifact : a)),
    artifact,
  }
}

export const ArtifactsStoreLive: Layer.Layer<ArtifactsRead | ArtifactsWrite> = Layer.unwrap(
  Effect.gen(function* () {
    const ref = yield* Ref.make<ArtifactsState>({ sessions: {} })
    const write = {
      read: (sessionId, branchId, query) =>
        Ref.get(ref).pipe(
          Effect.map((state) => readArtifact(sessionItems(state, sessionId), branchId, query)),
        ),
      list: (sessionId, branchId) =>
        Ref.get(ref).pipe(
          Effect.map((state) => listArtifacts(sessionItems(state, sessionId), branchId)),
        ),
      save: (sessionId, branchId, input) =>
        Ref.modify(ref, (state) => {
          const result = saveArtifact(sessionItems(state, sessionId), branchId, input)
          return [result.artifact, setSessionItems(state, sessionId, result.items)]
        }),
      update: (sessionId, branchId, input) =>
        Ref.modify(ref, (state) => {
          const result = updateArtifact(sessionItems(state, sessionId), branchId, input)
          return [result.artifact, setSessionItems(state, sessionId, result.items)]
        }),
      clear: (sessionId, branchId, id) =>
        Ref.update(ref, (state) =>
          setSessionItems(
            state,
            sessionId,
            sessionItems(state, sessionId).filter(
              (artifact) => artifact.id !== id || artifact.branchId !== branchId,
            ),
          ),
        ),
    } satisfies ArtifactsWriteShape
    const read = withReadOnly({
      read: write.read,
      list: write.list,
    } satisfies ArtifactsReadShape)
    return Layer.merge(Layer.succeed(ArtifactsWrite, write), Layer.succeed(ArtifactsRead, read))
  }),
)
