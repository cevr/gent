import { Effect } from "effect"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
} from "@gent/core/extensions/api"

// What a Gent agent is and how it works. The loop states how a turn ends and
// nothing else; the tools a deployment ships say how work gets done in their
// own prompt sections.
const IDENTITY = `You are Gent, a general purpose agent.
You solve tasks by breaking problems into sub-tasks, using the tools available to you, observing results, and iterating.
When you are done, stop calling tools and state your final answer.`

const WORK = `# Work

- Evaluate an external project through its own interface (its build, tests, and commands). Your tools coordinate and analyze; they are not the target's runtime.
- Read before you edit. Match the existing style. Fix root causes. Touch only what the task needs. Verify with the project's checks before you report.
- For slow or independent work, start it, keep the handle, and end the turn. Do not keep a turn open by sleeping or polling.
- Delegate independent, self-contained work to children. A child inherits your agent and model and has no conversation history, so give it a complete task. Do a single lookup, edit, or command inline.
- When work spans many steps or children, give short progress updates: what is done, what is blocked, what is next.`

const COMMUNICATION = `# Communication

- Short sentences. Common words. One action or fact per sentence. Lists for steps and conditions.
- Keep commands, code, paths, names, and quoted text exact. State uncertainty directly.
- Reference code as \`file:line\`. No preamble. No emoji unless asked.`

const BOUNDARIES = `# Boundaries

- Never revert changes you did not make.
- Never run destructive git commands without explicit permission.
- Never expose secrets, API keys, or credentials in code or output.`

/** The persona sections every turn starts from; a project or user extension shadows any of them by id. */
export const basePromptSections = [
  { id: "identity", content: IDENTITY, priority: 0 },
  { id: "work", content: WORK, priority: 10 },
  { id: "communication", content: COMMUNICATION, priority: 20 },
  { id: "boundaries", content: BOUNDARIES, priority: 50 },
]

/**
 * The one shipped agent and its persona. Its model is `DEFAULT_MODEL_ID`.
 * Children spawned from a cell inherit it, so there is no roster of role
 * agents to pick from.
 */
export const main = AgentDefinition.make({
  name: AgentName.make("main"),
  description: "General purpose agent that solves tasks with code in the cell",
  reasoningEffort: "max",
})

export const CoreAgents = [main] satisfies ReadonlyArray<AgentDefinition>

/** Sorts after the environment section and before extension sections such as skills. */
const PROJECT_INSTRUCTIONS_PRIORITY = 70

const SEPARATOR = "\n---\n"

/**
 * Project instruction locations in the order they appear in the prompt. Each
 * location reads `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is missing or
 * empty. When no location has content, the Claude user file stands in.
 */
const locations = Effect.fn("Agents.locations")(function* () {
  const { Files, cwd, home } = yield* ExtensionContext
  return [
    [Files.join(home, ".gent", "AGENTS.md"), Files.join(home, ".gent", "CLAUDE.md")],
    [Files.join(cwd, "AGENTS.md"), Files.join(cwd, "CLAUDE.md")],
    [Files.join(cwd, ".gent", "AGENTS.md"), Files.join(cwd, ".gent", "CLAUDE.md")],
  ]
})

const readIfPresent = Effect.fn("Agents.readIfPresent")(function* (path: string) {
  const { Files } = yield* ExtensionContext
  return yield* Effect.gen(function* () {
    if (!(yield* Files.exists(path))) return ""
    return (yield* Files.read(path)).trim()
  }).pipe(Effect.catchEager(() => Effect.succeed("")))
})

const readFirstNonEmpty = Effect.fn("Agents.readFirstNonEmpty")(function* (
  candidates: ReadonlyArray<string>,
) {
  for (const candidate of candidates) {
    const content = yield* readIfPresent(candidate)
    if (content.length > 0) return content
  }
  return ""
})

/**
 * The joined `AGENTS.md`/`CLAUDE.md` text, or an empty string when no file has
 * content. Files are read on every turn, so an edit reaches the next turn of a
 * running session; a file that cannot be read counts as absent.
 */
export const readProjectInstructions = Effect.fn("Agents.readProjectInstructions")(function* () {
  const { Files, home } = yield* ExtensionContext
  const contents: Array<string> = []
  for (const candidates of yield* locations()) {
    const content = yield* readFirstNonEmpty(candidates)
    if (content.length > 0) contents.push(content)
  }
  if (contents.length === 0) {
    const fallback = yield* readIfPresent(Files.join(home, ".claude", "CLAUDE.md"))
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

export const AgentsExtension = defineExtension({
  id: "@gent/agents",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", ...CoreAgents)
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const text = yield* readProjectInstructions()
        return { promptSections: [...basePromptSections, ...projectInstructionsSection(text)] }
      }),
    )
  }),
})
