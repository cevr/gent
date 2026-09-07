import { Clock, Context, Effect, Layer, Option, Crypto, Ref } from "effect"
import { type BranchId, ArtifactId, type SessionId } from "@gent/core/extensions/api"
import type { Artifact, ContentPatch, ReadQuery } from "../artifacts-protocol.js"

interface ArtifactsState {
  readonly sessions: Readonly<Record<SessionId, ReadonlyArray<Artifact>>>
}

export interface ArtifactSaveInput {
  readonly label: string
  readonly sourceTool: string
  readonly content: string
  readonly path?: string
  readonly metadata?: Artifact["metadata"]
  readonly branchId?: BranchId
}

export interface ArtifactUpdateInput {
  readonly id: ArtifactId
  readonly patch?: ContentPatch
  readonly metadata?: Artifact["metadata"]
  readonly status?: Artifact["status"]
  readonly label?: string
}

interface ArtifactsReadService {
  readonly read: (
    sessionId: SessionId,
    branchId: BranchId,
    query: ReadQuery,
  ) => Effect.Effect<Option.Option<Artifact>>
  readonly list: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<Artifact>>
}

interface ArtifactsWriteService extends ArtifactsReadService {
  readonly save: (
    sessionId: SessionId,
    branchId: BranchId,
    input: ArtifactSaveInput,
  ) => Effect.Effect<Artifact>
  readonly update: (
    sessionId: SessionId,
    branchId: BranchId,
    input: ArtifactUpdateInput,
  ) => Effect.Effect<Option.Option<Artifact>>
  readonly clear: (sessionId: SessionId, branchId: BranchId, id: ArtifactId) => Effect.Effect<void>
}

export class ArtifactsRead extends Context.Service<ArtifactsRead, ArtifactsReadService>()(
  "@gent/extensions/src/artifacts/store/ArtifactsRead",
) {}

export class ArtifactsWrite extends Context.Service<ArtifactsWrite, ArtifactsWriteService>()(
  "@gent/extensions/src/artifacts/store/ArtifactsWrite",
) {}

const applyPatch = (content: string, patch: ContentPatch): string => {
  if (patch.replaceAll === true) return content.replaceAll(patch.find, patch.replace)
  return content.replace(patch.find, patch.replace)
}

const sessionItems = (state: ArtifactsState, sessionId: SessionId): ReadonlyArray<Artifact> =>
  Option.fromNullishOr(state.sessions[sessionId]).pipe(Option.getOrElse(() => []))

const setSessionItems = (
  state: ArtifactsState,
  sessionId: SessionId,
  items: ReadonlyArray<Artifact>,
): ArtifactsState => ({ sessions: { ...state.sessions, [sessionId]: items } })

const readArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  query: ReadQuery,
): Option.Option<Artifact> => {
  if (query._tag === "ById") {
    return Option.fromNullishOr(items.find((a) => a.id === query.id && a.branchId === branchId))
  }
  return Option.fromNullishOr(
    items.find((a) => a.sourceTool === query.sourceTool && a.branchId === branchId),
  )
}

const listArtifacts = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
): ReadonlyArray<Artifact> => items.filter((a) => a.branchId === branchId)

const saveArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  input: ArtifactSaveInput,
  now: number,
  id: ArtifactId,
): ArtifactSaveMutation => {
  const existingIdx = items.findIndex(
    (a) => a.sourceTool === input.sourceTool && a.branchId === branchId,
  )
  let existing = Option.none<Artifact>()
  if (existingIdx >= 0) existing = Option.fromNullishOr(items[existingIdx])
  const artifact: Artifact = {
    id: existing.pipe(
      Option.map((value) => value.id),
      Option.getOrElse(() => id),
    ),
    label: input.label,
    sourceTool: input.sourceTool,
    content: input.content,
    path: input.path,
    status: "active",
    metadata: input.metadata,
    branchId,
    createdAt: existing.pipe(
      Option.map((value) => value.createdAt),
      Option.getOrElse(() => now),
    ),
    updatedAt: now,
  }
  let nextItems = [...items, artifact]
  if (existingIdx >= 0) {
    nextItems = items.map((value, index) => {
      if (index === existingIdx) return artifact
      return value
    })
  }
  return { items: nextItems, artifact }
}

interface ArtifactSaveMutation {
  readonly items: ReadonlyArray<Artifact>
  readonly artifact: Artifact
}

interface ArtifactMutation {
  readonly items: ReadonlyArray<Artifact>
  readonly artifact: Option.Option<Artifact>
}

const updateArtifact = (
  items: ReadonlyArray<Artifact>,
  branchId: BranchId,
  input: ArtifactUpdateInput,
  now: number,
): ArtifactMutation => {
  const idx = items.findIndex((a) => a.id === input.id && a.branchId === branchId)
  let existing = Option.none<Artifact>()
  if (idx >= 0) existing = Option.fromNullishOr(items[idx])
  if (Option.isNone(existing)) return { items, artifact: Option.none() }
  const patch = Option.fromNullishOr(input.patch)
  const metadata = Option.fromNullishOr(input.metadata)
  const status = Option.fromNullishOr(input.status)
  const label = Option.fromNullishOr(input.label)
  let content = existing.value.content
  if (Option.isSome(patch)) {
    content = applyPatch(existing.value.content, patch.value)
  }
  const artifact: Artifact = {
    ...existing.value,
    content,
    metadata: Option.getOrElse(metadata, () => existing.value.metadata),
    status: Option.getOrElse(status, () => existing.value.status),
    label: Option.getOrElse(label, () => existing.value.label),
    updatedAt: now,
  }
  return {
    items: items.map((value, index) => {
      if (index === idx) return artifact
      return value
    }),
    artifact: Option.some(artifact),
  }
}

export const ArtifactsStoreLive: Layer.Layer<ArtifactsRead | ArtifactsWrite, never, Crypto.Crypto> =
  Layer.unwrap(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
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
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const id = ArtifactId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))
            return yield* Ref.modify(ref, (state) => {
              const result = saveArtifact(sessionItems(state, sessionId), branchId, input, now, id)
              return [result.artifact, setSessionItems(state, sessionId, result.items)]
            })
          }),
        update: (sessionId, branchId, input) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            return yield* Ref.modify(ref, (state) => {
              const result = updateArtifact(sessionItems(state, sessionId), branchId, input, now)
              return [result.artifact, setSessionItems(state, sessionId, result.items)]
            })
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
      } satisfies ArtifactsWriteService
      const read = {
        read: write.read,
        list: write.list,
      } satisfies ArtifactsReadService
      return Layer.merge(Layer.succeed(ArtifactsWrite, write), Layer.succeed(ArtifactsRead, read))
    }),
  )
