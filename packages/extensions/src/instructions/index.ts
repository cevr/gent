/**
 * @gent/instructions extension — puts the project's `AGENTS.md` (or
 * `CLAUDE.md`) files into the system prompt as the `project-instructions`
 * section.
 *
 * Files are read on every turn, so an edit to `AGENTS.md` reaches the next
 * turn of a running session. A file that cannot be read counts as absent.
 */

import { Effect } from "effect"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionContextService,
} from "@gent/core/extensions/api"

export const INSTRUCTIONS_EXTENSION_ID = ExtensionId.make("@gent/instructions")

/** Sorts after the environment section and before extension sections such as skills. */
export const PROJECT_INSTRUCTIONS_PRIORITY = 70

const SEPARATOR = "\n---\n"

type Files = Pick<ExtensionContextService["Files"], "exists" | "read" | "join">

/**
 * Locations in the order they appear in the prompt. Each location reads
 * `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is missing or empty. When no
 * location has content, the Claude user file stands in.
 */
const locations = (files: Files, paths: { readonly cwd: string; readonly home: string }) => [
  [files.join(paths.home, ".gent", "AGENTS.md"), files.join(paths.home, ".gent", "CLAUDE.md")],
  [files.join(paths.cwd, "AGENTS.md"), files.join(paths.cwd, "CLAUDE.md")],
  [files.join(paths.cwd, ".gent", "AGENTS.md"), files.join(paths.cwd, ".gent", "CLAUDE.md")],
]

const readIfPresent = (files: Files, path: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (!(yield* files.exists(path))) return ""
    return (yield* files.read(path)).trim()
  }).pipe(Effect.catchEager(() => Effect.succeed("")))

const readFirstNonEmpty = (files: Files, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const content = yield* readIfPresent(files, candidate)
      if (content.length > 0) return content
    }
    return ""
  })

/** The joined instruction text, or an empty string when no file has content. */
export const readProjectInstructions = Effect.fn("Instructions.read")(function* (
  files: Files,
  paths: { readonly cwd: string; readonly home: string },
) {
  const contents: Array<string> = []
  for (const candidates of locations(files, paths)) {
    const content = yield* readFirstNonEmpty(files, candidates)
    if (content.length > 0) contents.push(content)
  }
  if (contents.length === 0) {
    const fallback = yield* readIfPresent(files, files.join(paths.home, ".claude", "CLAUDE.md"))
    if (fallback.length > 0) contents.push(fallback)
  }
  return contents.join(SEPARATOR)
})

export const projectInstructionsSection = (text: string) => {
  if (text === "") return []
  return [
    {
      id: "project-instructions",
      priority: PROJECT_INSTRUCTIONS_PRIORITY,
      content: `# Project Instructions\n\n${text}`,
    },
  ]
}

export const InstructionsExtension = defineExtension({
  id: INSTRUCTIONS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        const text = yield* readProjectInstructions(ctx.Files, { cwd: ctx.cwd, home: ctx.home })
        return { promptSections: projectInstructionsSection(text) }
      }),
    )
  }),
})
