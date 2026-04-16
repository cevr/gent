/**
 * Memory extension state — volatile, session-local.
 *
 * Session memories are ephemeral (lost on restart). The vault index and
 * project key are NOT stored here — they are derived from `MemoryVault`
 * on demand by `MemoryVaultProjection`. This is the
 * `derive-do-not-create-states` principle: disk is the source of truth;
 * there is no actor mirror to keep in sync.
 *
 * No stateSchema on actor definition — session memories don't survive a
 * process restart by design (use scope="project"/"global" tools to persist).
 */

import { Schema } from "effect"
import {
  type AgentEvent,
  type ExtensionReduceContext,
  type ReduceResult,
} from "@gent/core/extensions/api"
import { type MemoryScope, type MemorySource } from "./vault.js"

// ── Session memory (volatile) ──

export const SessionMemory = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  created: Schema.String,
})
export type SessionMemory = typeof SessionMemory.Type

// ── Extension state ──

export interface MemoryState {
  /** Session-local memories — volatile, not persisted to disk */
  readonly sessionMemories: ReadonlyArray<SessionMemory>
}

export const MemoryStateSchema = Schema.Struct({
  sessionMemories: Schema.Array(SessionMemory),
})

export const initialMemoryState: MemoryState = {
  sessionMemories: [],
}

// ── Reduce ──

/**
 * Reduce is minimal — most state changes happen through tool execution
 * and intent handling, which directly mutate via the vault service.
 * The reduce function only handles event-driven state updates.
 */
export const reduce = (
  state: MemoryState,
  _event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<MemoryState> => {
  // SessionStarted: vault index reload happens in init, not reduce.
  // Future: could react to TurnCompleted for auto-extraction.
  return { state }
}

// ── Session memory helpers ──

export const addSessionMemory = (state: MemoryState, memory: SessionMemory): MemoryState => ({
  ...state,
  sessionMemories: [...state.sessionMemories, memory],
})

export const removeSessionMemory = (state: MemoryState, title: string): MemoryState => ({
  ...state,
  sessionMemories: state.sessionMemories.filter((m) => m.title !== title),
})

// ── Slug generation ──

export const toSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)

/** Build the relative vault path for a memory entry */
export const memoryPath = (scope: MemoryScope, title: string, projectKey?: string): string => {
  const slug = toSlug(title)
  if (scope === "global") return `global/${slug}.md`
  if (projectKey === undefined) return `global/${slug}.md`
  return `project/${projectKey}/${slug}.md`
}

/** Build frontmatter for a new memory */
export const newFrontmatter = (
  scope: MemoryScope,
  tags: ReadonlyArray<string>,
  source: MemorySource,
) => ({
  scope,
  tags,
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  source,
})
