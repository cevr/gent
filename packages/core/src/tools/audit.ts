import { Effect, Schema } from "effect"
import {
  Agents,
  getAdversarialModels,
  SubagentRunnerService,
  type AgentDefinition,
  type SubagentRunner,
} from "../domain/agent.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { defineTool, type ToolContext } from "../domain/tool.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { requireText, runCommand, type WorkflowRunContext } from "../runtime/workflow-helpers.js"

interface AuditConcern {
  name: string
  description: string
}

interface AuditFinding {
  file: string
  description: string
  severity: "critical" | "warning" | "suggestion"
}

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
      description: "report: findings only, fix: apply changes iteratively",
    }),
  ),
})

const resolveAuditPaths = (paths?: ReadonlyArray<string>) => {
  if (paths !== undefined && paths.length > 0) {
    return Effect.succeed([...paths])
  }

  return runCommand(["git", "diff", "--name-only"]).pipe(
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

Respond with a numbered list:
1. <concern name>: <brief description>
2. <concern name>: <brief description>`
}

const parseConcerns = (text: string, maxConcerns: number): AuditConcern[] => {
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
    cowork: string
    deepwork: string
  }>,
  userPrompt?: string,
) => {
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  const notesBlock = notes
    .map(
      ({ concern, cowork, deepwork }) =>
        `## Concern: ${concern.name}\n${concern.description}\n\n### Cowork\n${cowork}\n\n### Deepwork\n${deepwork}`,
    )
    .join("\n\n---\n\n")

  return `Synthesize these audit notes into final findings.${focusBlock}
## Concern Notes
${notesBlock}

## Instructions
Deduplicate and keep only evidence-backed findings.
Drop findings not grounded in a specific file + line reference.
Group by file proximity so the executor can work in batches.
Return a numbered list in this exact format:
1. [critical|warning|suggestion] path/to/file.ts - finding description`
}

const parseFindings = (text: string): AuditFinding[] => {
  const findings: AuditFinding[] = []
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+\.\s*\[(critical|warning|suggestion)\]\s*(\S+)\s*[-–—]\s*(.+)$/i)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      findings.push({
        file: match[2].trim(),
        description: match[3].trim(),
        severity: match[1].toLowerCase() as AuditFinding["severity"],
      })
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
  runner: SubagentRunner
  architect: AgentDefinition
  auditor: AgentDefinition
  runnerContext: WorkflowRunContext
  paths: ReadonlyArray<string>
  prompt?: string
  maxConcerns: number
  evaluatorFeedback?: string
}) {
  const [coworkModel, deepworkModel] = getAdversarialModels()
  const auditOverrides = {
    allowedActions: ["read"] as const,
    deniedTools: ["bash"] as const,
  }

  const detectResult = yield* params.runner.run({
    agent: params.architect,
    prompt: buildDetectPrompt(
      params.prompt,
      params.paths,
      params.maxConcerns,
      params.evaluatorFeedback,
    ),
    ...params.runnerContext,
    overrides: { ...auditOverrides, modelId: coworkModel },
  })
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
        const [coworkResult, deepworkResult] = yield* Effect.all(
          [
            params.runner.run({
              agent: params.auditor,
              prompt,
              ...params.runnerContext,
              overrides: { ...auditOverrides, modelId: coworkModel },
            }),
            params.runner.run({
              agent: params.auditor,
              prompt,
              ...params.runnerContext,
              overrides: { ...auditOverrides, modelId: deepworkModel },
            }),
          ] as const,
          { concurrency: 2 },
        )

        return {
          concern,
          cowork: yield* requireText(coworkResult, `${concern.name}-cowork`),
          deepwork: yield* requireText(deepworkResult, `${concern.name}-deepwork`),
        }
      }),
    { concurrency: 4 },
  )

  const synthesisResult = yield* params.runner.run({
    agent: params.architect,
    prompt: buildSynthesisPrompt(pairedNotes, params.prompt),
    ...params.runnerContext,
    overrides: { ...auditOverrides, modelId: coworkModel },
  })
  const raw = yield* requireText(synthesisResult, "audit-synthesize")
  const findings = parseFindings(raw)
  return { raw, findings }
})

export const AuditTool = defineTool({
  name: "audit",
  action: "delegate" as const,
  concurrency: "serial" as const,
  description:
    "Audit code with dual-model concern analysis. Report mode presents findings. Fix mode executes them iteratively.",
  promptSnippet: "Audit code with dual-model concern analysis",
  promptGuidelines: [
    "Use report mode for read-only findings, fix mode for iterative resolution",
    "Specify paths to scope the audit; defaults to git diff",
  ],
  params: AuditParams,
  execute: Effect.fn("AuditTool.execute")(function* (params, ctx: ToolContext) {
    const runner = yield* SubagentRunnerService
    const presenter = yield* PromptPresenter
    const registry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform

    const mode = params.mode ?? "report"
    const maxConcerns = params.maxConcerns ?? 5
    const paths = yield* resolveAuditPaths(params.paths)
    const runnerContext: WorkflowRunContext = {
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: platform.cwd,
    }

    const architect = (yield* registry.getAgent("architect")) ?? Agents.architect
    const auditor = (yield* registry.getAgent("auditor")) ?? Agents.auditor
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = (yield* registry.getAgent(callerAgentName)) ?? Agents.cowork

    // Detect → adversarial audit → synthesize (always runs)
    const report = yield* runAuditCycle({
      runner,
      architect,
      auditor,
      runnerContext,
      paths,
      prompt: params.prompt,
      maxConcerns,
    })

    if (mode === "report") {
      yield* presenter.present({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        content: report.raw,
        title: "Audit Findings",
      })
      return { mode, output: report.raw, findings: report.findings, paths }
    }

    // Fix mode: single cycle — audit + execute. Agent uses @gent/auto for iteration.
    if (report.findings.length === 0) {
      return { mode, output: "No findings to fix.", findings: [], paths }
    }

    const execResult = yield* runner.run({
      agent: executor,
      prompt: buildExecutionPrompt(report.findings, params.prompt),
      ...runnerContext,
    })
    const execOutput = execResult._tag === "success" ? execResult.text : "Execution failed."

    return { mode, output: execOutput, findings: report.findings, paths }
  }),
})
