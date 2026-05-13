/**
 * Example: One-file session notes extension.
 *
 * Demonstrates the public authoring loop:
 *   - process-scoped extension state
 *   - one model-callable tool
 *   - one slash-presented request
 *   - one turn projection hook
 */
import { Context, Effect, Schema } from "effect"
import {
  defineExtension,
  defineStateResource,
  hook,
  request,
  tool,
  type ExtensionState,
} from "@gent/core/extensions/api"

interface NotesState {
  readonly notes: ReadonlyArray<string>
}

class SessionNotesState extends Context.Service<SessionNotesState, ExtensionState<NotesState>>()(
  "gent/examples/extensions/session-notes/SessionNotesState",
) {}

const NoteInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Note text to remember for this session" }),
})

const NoteOutput = Schema.Struct({
  count: Schema.Number,
  latest: Schema.String,
})

export const AddNoteTool = tool({
  id: "session_note_add",
  description: "Remember a short note for this session",
  params: NoteInput,
  output: NoteOutput,
  promptSnippet: "Remember session-local notes that may help later turns.",
  execute: ({ text }) =>
    Effect.gen(function* () {
      const state = yield* SessionNotesState
      return yield* state.modify((current) => [
        { count: current.notes.length + 1, latest: text },
        { notes: [...current.notes, text] },
      ])
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
      const state = yield* SessionNotesState
      const snapshot = yield* state.get
      if (snapshot.notes.length === 0) return "No session notes yet."
      return snapshot.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")
    }),
})

export default defineExtension({
  id: "session-notes",
  resources: [
    defineStateResource({
      tag: SessionNotesState,
      scope: "process",
      initial: { notes: [] },
    }),
  ],
  tools: [AddNoteTool],
  requests: [SessionNotesSummary],
  hooks: [
    hook.turnProjection(() =>
      Effect.gen(function* () {
        const state = yield* SessionNotesState
        const snapshot = yield* state.get
        if (snapshot.notes.length === 0) return {}
        return {
          promptSections: [
            {
              id: "session-notes",
              priority: 20,
              content: snapshot.notes.map((note) => `- ${note}`).join("\n"),
            },
          ],
          toolPolicy: { include: ["session_note_add"] },
        }
      }),
    ),
  ],
})
