/**
 * Example: One-file session notes extension.
 *
 * Demonstrates the public authoring loop:
 *   - process-scoped extension state (a Ref behind the extension's own Tag).
 *     One Ref serves the whole process, so the notes are keyed by
 *     `ExtensionContext.sessionId`: each session reads only its own.
 *   - one model-callable tool
 *   - one slash-presented request
 *   - one turn projection hook
 */
import { Context, Effect, HashMap, Layer, Option, Ref, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  request,
  tool,
  type SessionId,
} from "@gent/core/extensions/api"

/** Every session's notes, keyed by the session that wrote them. */
type NotesState = HashMap.HashMap<SessionId, ReadonlyArray<string>>

class SessionNotesState extends Context.Service<SessionNotesState, Ref.Ref<NotesState>>()(
  "@gent/examples/extensions/session-notes/SessionNotesState",
) {}

/** The current session's notes. */
const currentNotes = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const state = yield* Ref.get(yield* SessionNotesState)
  return Option.getOrElse(HashMap.get(state, ctx.sessionId), (): ReadonlyArray<string> => [])
})

const NoteInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Note text to remember" }),
})

const NoteOutput = Schema.Struct({
  count: Schema.Finite,
  latest: Schema.String,
})

export const AddNoteTool = tool({
  id: "session_note_add",
  description: "Remember a short note for this session",
  params: NoteInput,
  output: NoteOutput,
  promptSnippet: "Remember notes that may help later turns.",
  execute: ({ text }) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const state = yield* SessionNotesState
      return yield* Ref.modify(state, (current) => {
        const notes = [
          ...Option.getOrElse(HashMap.get(current, ctx.sessionId), (): ReadonlyArray<string> => []),
          text,
        ]
        return [{ count: notes.length, latest: text }, HashMap.set(current, ctx.sessionId, notes)]
      })
    }),
})

export const SessionNotesSummary = request({
  id: "session-notes-summary",
  slash: {
    trigger: "notes",
    name: "Session Notes",
    description: "Show notes remembered by the session notes extension",
    category: "Session",
  },
  input: Schema.Struct({}),
  output: Schema.String,
  execute: () =>
    Effect.gen(function* () {
      const notes = yield* currentNotes
      if (notes.length === 0) return "No session notes yet."
      return notes.map((note, index) => `${index + 1}. ${note}`).join("\n")
    }),
})

export default defineExtension({
  id: "session-notes",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "example/session-notes/state",
        scope: "process",
        layer: Layer.effect(SessionNotesState, Ref.make<NotesState>(HashMap.empty())),
      }),
    )
    yield* host.register("tool", AddNoteTool)
    yield* host.register("request", SessionNotesSummary)
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const notes = yield* currentNotes
        if (notes.length === 0) return {}
        return {
          promptSections: [
            {
              id: "session-notes",
              priority: 20,
              content: notes.map((note) => `- ${note}`).join("\n"),
            },
          ],
        }
      }),
    )
  }),
})
