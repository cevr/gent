/**
 * Example: One-file session notes extension.
 *
 * Demonstrates the public authoring loop:
 *   - process-scoped extension state (a Ref behind the extension's own Tag)
 *   - one model-callable tool
 *   - one slash-presented request
 *   - one turn projection hook
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  request,
  tool,
} from "@gent/core/extensions/api"

interface NotesState {
  readonly notes: ReadonlyArray<string>
}

class SessionNotesState extends Context.Service<SessionNotesState, Ref.Ref<NotesState>>()(
  "gent/examples/extensions/session-notes/SessionNotesState",
) {}

const NoteInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Note text to remember for this session" }),
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
  promptSnippet: "Remember session-local notes that may help later turns.",
  execute: ({ text }) =>
    Effect.gen(function* () {
      const state = yield* SessionNotesState
      return yield* Ref.modify(state, (current) => [
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
      const snapshot = yield* Ref.get(yield* SessionNotesState)
      if (snapshot.notes.length === 0) return "No session notes yet."
      return snapshot.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")
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
        tag: SessionNotesState,
        scope: "process",
        layer: Layer.effect(SessionNotesState, Ref.make<NotesState>({ notes: [] })),
      }),
    )
    yield* host.register("tool", AddNoteTool)
    yield* host.register("request", SessionNotesSummary)
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(yield* SessionNotesState)
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
    )
  }),
})
