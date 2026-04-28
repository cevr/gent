import { Effect, Schema } from "effect"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
  ref,
  tool,
  ToolNeeds,
  type AgentDefinition,
  type ToolContext,
  type ExtensionHostContext,
  type ToolCallId,
} from "@gent/core/extensions/api"
import { requireText, runCommand } from "../workflow-helpers.js"
import { ArtifactRpc } from "../artifacts-protocol.js"

const AuditConcernSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type AuditConcern = typeof AuditConcernSchema.Type

const AuditFindingSchema = Schema.Struct({
  file: Schema.String,
  description: Schema.String,
  severity: Schema.Literals(["critical", "warning", "suggestion"]),
})
type AuditFinding = typeof AuditFindingSchema.Type

export const AuditParams = Schema.Struct({
  prompt: Schema.optional(
    Schema.String.annotate({ description: "Focus area or specific concern" }),
  ),
  paths: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Paths to audit (default: changed files from git diff --name-only)",
    }),
  ),
  maxConcerns: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 8 })).annotate({
      description: "Max concern categories to audit (default 5)",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["fix", "report"]).annotate({
      description: "report: findings only, fix: detect and apply changes (single cycle)",
    }),
  ),
})

const resolveAuditPaths = (paths: ReadonlyArray<string> | undefined, cwd: string) => {
  if (paths !== undefined && paths.length > 0) {
    return Effect.succeed([...paths])
  }

  return runCommand(["git", "diff", "--name-only"], cwd).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  )
}

const buildDetectPrompt = (
  userPrompt: string | undefined,
  paths: ReadonlyArray<string>,
  maxConcerns: number,
  evaluatorFeedback?: string,
) => {
  const pathsList =
    paths.length > 0 ? paths.map((path) => `- ${path}`).join("\n") : "(no specific paths)"
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  const feedbackBlock =
    evaluatorFeedback !== undefined && evaluatorFeedback !== ""
      ? `\n## Remaining Issues\n${evaluatorFeedback}\n`
      : ""

  return `Identify audit concerns for this code.${focusBlock}${feedbackBlock}
## Paths
${pathsList}

## Instructions
Identify ${maxConcerns} or fewer concrete concern categories.
Each concern must be a distinct audit pass — no overlap between concerns.
Examples: error handling, typing, concurrency, security, performance.

Respond ONLY with a JSON array:
[{"name":"<concern name>","description":"<brief description>"}]

If JSON is not possible, fall back to a numbered list:
1. <concern name>: <brief description>`
}

const parseConcerns = (text: string, maxConcerns: number): AuditConcern[] => {
  // Try JSON first, fall back to regex
  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(AuditConcernSchema)),
    )(text.trim())
    return [...parsed.slice(0, maxConcerns)]
  } catch {
    // Fall back to regex parsing for numbered list format
  }
  const concerns: AuditConcern[] = []
  const pattern = /^(?:\d+[.)]\s*|\s*[-*]\s*)(?:\*\*)?(.+?)(?:\*\*)?:\s*(.+)$/
  for (const line of text.split("\n")) {
    const match = line.match(pattern)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      concerns.push({ name: match[1].trim(), description: match[2].trim() })
    }
    if (concerns.length >= maxConcerns) break
  }
  return concerns
}

const buildConcernAuditPrompt = (
  concern: AuditConcern,
  paths: ReadonlyArray<string>,
  userPrompt?: string,
) => {
  const pathsList =
    paths.length > 0 ? paths.map((path) => `- ${path}`).join("\n") : "(no specific paths)"
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""

  return `Audit the code for this concern: ${concern.name}
${concern.description}${focusBlock}
## Paths
${pathsList}

## Instructions
Read the relevant files.
Identify concrete findings tied to this concern only.
Include file paths in every finding.`
}

const buildSynthesisPrompt = (
  notes: ReadonlyArray<{
    concern: AuditConcern
    primary: string
    reviewer: string
  }>,
  userPrompt?: string,
) => {
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  const notesBlock = notes
    .map(
      ({ concern, primary, reviewer }) =>
        `## Concern: ${concern.name}\n${concern.description}\n\n### Primary\n${primary}\n\n### Reviewer\n${reviewer}`,
    )
    .join("\n\n---\n\n")

  return `Synthesize these audit notes into final findings.${focusBlock}
## Concern Notes
${notesBlock}

## Instructions
Deduplicate and keep only evidence-backed findings.
Drop findings not grounded in a specific file + line reference.
Group by file proximity so the executor can work in batches.
Return ONLY a JSON array:
[{"file":"path/to/file.ts","description":"finding description","severity":"critical|warning|suggestion"}]

If JSON is not possible, fall back to a numbered list:
1. [critical|warning|suggestion] path/to/file.ts - finding description`
}

const parseFindings = (text: string): AuditFinding[] => {
  // Try JSON first, fall back to regex
  try {
    return [
      ...Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(AuditFindingSchema)))(
        text.trim(),
      ),
    ]
  } catch {
    // Fall back to regex parsing for numbered list format
  }
  const findings: AuditFinding[] = []
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+\.\s*\[(critical|warning|suggestion)\]\s*(\S+)\s*[-–—]\s*(.+)$/i)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      const sev = match[1].toLowerCase()
      if (sev === "critical" || sev === "warning" || sev === "suggestion") {
        findings.push({
          file: match[2].trim(),
          description: match[3].trim(),
          severity: sev,
        })
      }
    }
  }
  return findings
}

const buildExecutionPrompt = (findings: ReadonlyArray<AuditFinding>, userPrompt?: string) => {
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  return `Execute this audit plan.${focusBlock}
## Findings
${findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file} - ${finding.description}`).join("\n")}

## Instructions
Work through the findings in small batches grouped by file or dependency.
Apply the fixes directly.
Group related fixes where that reduces churn.
Summarize what changed, which findings are resolved, and what remains.`
}

const runAuditCycle = Effect.fn("runAuditCycle")(function* (params: {
  ctx: ExtensionHostContext
  architect: AgentDefinition
  auditor: AgentDefinition
  toolCallId?: ToolCallId
  paths: ReadonlyArray<string>
  prompt?: string
  maxConcerns: number
  evaluatorFeedback?: string
}) {
  const { ctx } = params
  const [primaryModel, reviewerModel] = yield* ctx.agent.resolveDualModelPair()
  const auditOverrides = {
    allowedTools: ["grep", "glob", "read", "memory_search"] as const,
    deniedTools: ["bash"] as const,
  }

  const runAgent = (agent: AgentDefinition, prompt: string, modelId: typeof primaryModel) =>
    ctx.agent.run({
      agent,
      prompt,
      runSpec: makeRunSpec({
        persistence: "ephemeral",
        parentToolCallId: params.toolCallId,
        overrides: { ...auditOverrides, modelId },
      }),
    })

  const detectResult = yield* runAgent(
    params.architect,
    buildDetectPrompt(params.prompt, params.paths, params.maxConcerns, params.evaluatorFeedback),
    primaryModel,
  )
  const detectText = yield* requireText(detectResult, "audit-detect")
  const concerns = parseConcerns(detectText, params.maxConcerns)

  if (concerns.length === 0) {
    return { raw: "No concerns detected.", findings: [] as AuditFinding[] }
  }

  const pairedNotes = yield* Effect.forEach(
    concerns,
    (concern) =>
      Effect.gen(function* () {
        const prompt = buildConcernAuditPrompt(concern, params.paths, params.prompt)
        const [primaryResult, reviewerResult] = yield* Effect.all(
          [
            runAgent(params.auditor, prompt, primaryModel),
            runAgent(params.auditor, prompt, reviewerModel),
          ] as const,
          { concurrency: 2 },
        )

        return {
          concern,
          primary: yield* requireText(primaryResult, `${concern.name}-primary`),
          reviewer: yield* requireText(reviewerResult, `${concern.name}-reviewer`),
        }
      }),
    { concurrency: 4 },
  )

  const synthesisResult = yield* runAgent(
    params.architect,
    buildSynthesisPrompt(pairedNotes, params.prompt),
    primaryModel,
  )
  const raw = yield* requireText(synthesisResult, "audit-synthesize")
  const findings = parseFindings(raw)
  return { raw, findings }
})

export const AuditTool = tool({
  id: "audit",
  needs: [ToolNeeds.write("agent")],
  description:
    "Audit code with dual-model concern analysis. Report mode presents findings. Fix mode runs one detect-audit-synthesize-execute cycle. Use @gent/auto for iterative refinement.",
  promptSnippet: "Audit code with dual-model concern analysis",
  promptGuidelines: [
    "Use report mode for read-only findings, fix mode for single-cycle detect+execute",
    "For iterative audit loops, start @gent/auto then call audit each iteration",
    "Specify paths to scope the audit; defaults to git diff",
  ],
  params: AuditParams,
  execute: Effect.fn("AuditTool.execute")(function* (params, ctx: ToolContext) {
    const mode = params.mode ?? "report"
    const maxConcerns = params.maxConcerns ?? 5
    const paths = yield* resolveAuditPaths(params.paths, ctx.cwd)

    const architect = yield* ctx.agent.require(AgentName.make("architect"))
    const auditor = yield* ctx.agent.require(AgentName.make("auditor"))
    const callerAgentName = ctx.agentName ?? DEFAULT_AGENT_NAME
    const executor = yield* ctx.agent.require(callerAgentName)

    // Detect → adversarial audit → synthesize (always runs)
    const report = yield* runAuditCycle({
      ctx,
      architect,
      auditor,
      toolCallId: ctx.toolCallId,
      paths,
      prompt: params.prompt,
      maxConcerns,
    })

    // Persist as artifact for prompt projection
    yield* ctx.extension
      .request(ref(ArtifactRpc.Save), {
        label: `Audit: ${report.findings.length} findings`,
        sourceTool: "audit",
        content: report.raw,
        metadata: { findingCount: report.findings.length, paths },
        branchId: ctx.branchId,
      })
      .pipe(Effect.ignoreCause)

    if (mode === "report") {
      yield* ctx.interaction.present({
        content: report.raw,
        title: "Audit Findings",
      })
      return { mode, output: report.raw, findings: report.findings, paths }
    }

    // Fix mode: single cycle — audit + execute. Agent uses @gent/auto for iteration.
    if (report.findings.length === 0) {
      return { mode, output: "No findings to fix.", findings: [], paths }
    }

    // Executor applies fixes — durable so the user can navigate to the child session.
    const execResult = yield* ctx.agent.run({
      agent: executor,
      prompt: buildExecutionPrompt(report.findings, params.prompt),
      runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: ctx.toolCallId }),
    })
    const execOutput = execResult._tag === "success" ? execResult.text : "Execution failed."

    return { mode, output: execOutput, findings: report.findings, paths }
  }),
})
