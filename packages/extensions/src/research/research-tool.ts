import { Effect, Schema } from "effect"
import { defineAgent, defineTool, type ToolContext } from "@gent/core/extensions/api"
import { requireText } from "../workflow-helpers.js"
import { fetchRepo, getRepoCachePath } from "../librarian/repo-explorer.js"

const MAX_REPOS = 5
const MAX_CONCURRENCY = 3

const RESEARCHER_PROMPT = `
You are researching an external repository to answer a specific question.
You have access to a local clone at the path specified in the prompt.
Use read, grep, and glob tools to explore the code. Be precise — cite file paths and line numbers.
Structure your findings clearly. Focus on the specific question asked.
When comparing implementations, note patterns, tradeoffs, and design decisions.
`.trim()

const researchAgent = defineAgent({
  name: "research-worker",
  allowedTools: ["grep", "glob", "read", "memory_search"],
  systemPromptAddendum: RESEARCHER_PROMPT,
})

export const ResearchParams = Schema.Struct({
  question: Schema.String.annotate({
    description: "What you want to understand — drives the research focus",
  }),
  repos: Schema.Array(Schema.String).annotate({
    description:
      "Repository specs to research: owner/repo, owner/repo@tag, npm:package. Single = focused explanation, multiple = comparative analysis.",
  }),
  focus: Schema.optional(
    Schema.String.annotate({
      description: "Narrow the search: specific file paths, modules, or patterns to examine",
    }),
  ),
})

const buildResearchPrompt = (question: string, repoPath: string, spec: string, focus?: string) =>
  [
    `Research the repository at ${repoPath} (${spec}).`,
    "",
    "## Question",
    question,
    ...(focus !== undefined && focus.trim() !== ""
      ? ["", "## Focus", `Narrow your search to: ${focus}`]
      : []),
    "",
    "## Instructions",
    "Read the code to answer the question. Cite specific file paths and line numbers.",
    "Report patterns, design decisions, and implementation details relevant to the question.",
  ].join("\n")

const buildSynthesisPrompt = (
  question: string,
  findings: ReadonlyArray<{ spec: string; text: string }>,
  focus?: string,
) =>
  [
    findings.length === 1
      ? "Summarize these research findings into a clear, actionable answer."
      : "Synthesize these research findings into a comparative analysis.",
    "",
    "## Question",
    question,
    ...(focus !== undefined && focus.trim() !== "" ? ["", "## Focus", focus] : []),
    "",
    ...findings.flatMap((f) => [`## ${f.spec}`, f.text, ""]),
    "## Instructions",
    findings.length === 1
      ? "Produce a clear answer grounded in the specific files and patterns found."
      : "Compare approaches across repos. Note patterns, tradeoffs, and design decisions. Recommend based on evidence.",
  ].join("\n")

export const ResearchTool = defineTool({
  name: "research",
  resources: ["research"],
  description:
    "Research external repositories to understand how they work. Single repo for focused explanation, multiple repos for comparative analysis.",
  promptSnippet: "Research external repositories",
  promptGuidelines: [
    "Use to understand how a library or framework works internally",
    "Use to compare implementations across repos before choosing an approach",
    "Single repo: focused explanation of patterns and design decisions",
    "Multiple repos: comparative analysis with tradeoffs",
    "Include focus to narrow search to specific modules or patterns",
  ],
  params: ResearchParams,
  execute: Effect.fn("ResearchTool.execute")(function* (params, ctx: ToolContext) {
    if (params.repos.length === 0) {
      return { error: "At least one repository spec required" }
    }
    if (params.repos.length > MAX_REPOS) {
      return { error: `Too many repos (max ${MAX_REPOS})` }
    }

    // Fetch repos and resolve cache paths
    const repoPaths = yield* Effect.forEach(
      params.repos,
      (spec) =>
        fetchRepo(spec, ctx.home).pipe(
          Effect.map((path) => ({ spec, path })),
          Effect.catchEager(() => Effect.succeed({ spec, path: getRepoCachePath(ctx.home, spec) })),
        ),
      { concurrency: MAX_CONCURRENCY },
    )

    // Dispatch research agent per repo
    const results = yield* Effect.forEach(
      repoPaths,
      ({ spec, path }) =>
        ctx.agent.run({
          agent: researchAgent,
          prompt: buildResearchPrompt(params.question, path, spec, params.focus),
          runSpec: { persistence: "ephemeral", parentToolCallId: ctx.toolCallId },
        }),
      { concurrency: MAX_CONCURRENCY },
    )

    const findings: Array<{ spec: string; text: string }> = []
    for (const [i, result] of results.entries()) {
      const spec = repoPaths[i]?.spec ?? "unknown"
      if (result._tag === "success" && result.text.trim() !== "") {
        findings.push({ spec, text: result.text })
      }
    }

    if (findings.length === 0) {
      return { error: "No findings from any repository" }
    }

    // Single finding — return directly (no synthesis needed)
    if (findings.length === 1) {
      return {
        response: findings[0]?.text ?? "",
        repos: params.repos,
      }
    }

    // Multiple findings — synthesize with cross-vendor model
    const [, modelB] = yield* ctx.agent.resolveDualModelPair()
    const synthesisResult = yield* ctx.agent.run({
      agent: researchAgent,
      prompt: buildSynthesisPrompt(params.question, findings, params.focus),
      runSpec: {
        persistence: "ephemeral",
        parentToolCallId: ctx.toolCallId,
        overrides: { modelId: modelB },
      },
    })

    const synthesis = yield* requireText(synthesisResult, "synthesis")

    return {
      response: synthesis,
      repos: params.repos,
      repoCount: findings.length,
    }
  }),
})
