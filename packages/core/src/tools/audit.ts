import { Effect, Schema } from "effect"
import {
  Agents,
  getAdversarialModels,
  SubagentRunnerService,
  type AgentDefinition,
  type SubagentRunner,
} from "../domain/agent.js"
import { EventStore, WorkflowCompleted, WorkflowPhaseStarted } from "../domain/event.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { runLoop } from "../runtime/loop.js"
import { Storage } from "../storage/sqlite-storage.js"
import { extractLoopEvaluation, requireText, type WorkflowRunContext } from "./workflow-helpers.js"

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
  maxIterations: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "Max audit loop iterations in fix mode (default 3)",
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

const runCommand = (cmd: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) {
        throw new Error(stderr || `Command failed: ${cmd.join(" ")}`)
      }
      return stdout
    },
    catch: () => "",
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
Each concern should be a distinct audit pass like error handling, typing, concurrency, security, or performance.

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
Group related findings near each other so the executor can work in batches.
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

const buildEvaluationPrompt = (
  executionOutput: string,
  findings: ReadonlyArray<AuditFinding>,
) => `Evaluate whether the audit findings have been resolved.

## Findings
${findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file} - ${finding.description}`).join("\n")}

## Execution Output
${executionOutput}

## Instructions
You MUST call the loop_evaluation tool.
- verdict: "done" if the findings are addressed
- verdict: "continue" if more work is needed
- summary: brief explanation of what remains or why it is done`

const runAuditCycle = Effect.fn("runAuditCycle")(function* (params: {
  runner: SubagentRunner
  architect: AgentDefinition
  auditor: AgentDefinition
  runnerContext: WorkflowRunContext
  paths: ReadonlyArray<string>
  prompt?: string
  maxConcerns: number
  evaluatorFeedback?: string
  emitPhase: (phase: string) => Effect.Effect<void, never>
}) {
  const [coworkModel, deepworkModel] = getAdversarialModels()
  const auditOverrides = {
    allowedActions: ["read"] as const,
    deniedTools: ["bash"] as const,
  }

  yield* params.emitPhase("detect")
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

  yield* params.emitPhase("audit")
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

  yield* params.emitPhase("synthesize")
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

export const AuditTool = defineWorkflow({
  name: "audit",
  description:
    "Audit code with dual-model concern analysis. Report mode presents findings. Fix mode executes them iteratively.",
  command: "audit",
  phases: ["detect", "audit", "synthesize", "present", "execute", "evaluate"] as const,
  params: AuditParams,
  execute: Effect.fn("AuditTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const presenter = yield* PromptPresenter
    const storage = yield* Storage
    const registry = yield* ExtensionRegistry

    const mode = params.mode ?? "report"
    const maxIterations = params.maxIterations ?? 3
    const maxConcerns = params.maxConcerns ?? 5
    const paths = yield* resolveAuditPaths(params.paths)
    const runnerContext: WorkflowRunContext = {
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    }

    const architect = (yield* registry.getAgent("architect")) ?? Agents.architect
    const auditor = (yield* registry.getAgent("auditor")) ?? Agents.auditor
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = (yield* registry.getAgent(callerAgentName)) ?? Agents.cowork

    const emitPhase = (phase: string) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "audit",
            phase,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const emitIterationPhase = (phase: string, iteration: number) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "audit",
            phase,
            iteration,
            maxIterations,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const completeWorkflow = (result: "success" | "rejected" | "error" | "max_iterations") =>
      eventStore
        .publish(
          new WorkflowCompleted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "audit",
            result,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    if (mode === "report") {
      const report = yield* runAuditCycle({
        runner,
        architect,
        auditor,
        runnerContext,
        paths,
        prompt: params.prompt,
        maxConcerns,
        emitPhase,
      })

      yield* emitPhase("present")
      yield* presenter.present({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        content: report.raw,
        title: "Audit Findings",
      })
      yield* completeWorkflow("success")

      return {
        iterations: 1,
        reason: "done" as const,
        output: report.raw,
        findings: report.findings,
        raw: report.raw,
        paths,
      }
    }

    let latestFindings: ReadonlyArray<AuditFinding> = []

    const loopResult = yield* runLoop({
      maxIterations,
      body: (iteration, _previousOutput, evaluatorFeedback) =>
        Effect.gen(function* () {
          const report = yield* runAuditCycle({
            runner,
            architect,
            auditor,
            runnerContext,
            paths,
            prompt: params.prompt,
            maxConcerns,
            evaluatorFeedback,
            emitPhase,
          })
          latestFindings = report.findings

          if (report.findings.length === 0) {
            return {
              _tag: "success" as const,
              text: "No concerns detected.",
              sessionId: ctx.sessionId,
              agentName: callerAgentName,
            }
          }

          yield* emitIterationPhase("execute", iteration)
          return yield* runner.run({
            agent: executor,
            prompt: buildExecutionPrompt(report.findings, params.prompt),
            ...runnerContext,
          })
        }),
      evaluate: (iteration, bodyOutput) =>
        Effect.gen(function* () {
          if (latestFindings.length === 0) {
            return { verdict: "done" as const, feedback: "No findings remain." }
          }

          yield* emitIterationPhase("evaluate", iteration)
          const evalResult = yield* runner.run({
            agent: architect,
            prompt: buildEvaluationPrompt(bodyOutput, latestFindings),
            ...runnerContext,
            overrides: {
              allowedActions: ["read"],
              deniedTools: ["bash"],
              tags: ["loop-evaluation"],
            },
          })

          if (evalResult._tag === "error") return { verdict: "done" as const }
          const envelopes = yield* storage
            .listEvents({ sessionId: evalResult.sessionId })
            .pipe(Effect.catchEager(() => Effect.succeed([])))
          return extractLoopEvaluation(envelopes, evalResult.text)
        }),
    })

    yield* completeWorkflow(
      loopResult.reason === "done"
        ? "success"
        : loopResult.reason === "error"
          ? "error"
          : "max_iterations",
    )

    return {
      findings: latestFindings,
      iterations: loopResult.iterations,
      reason: loopResult.reason,
      output: loopResult.output,
      paths,
      ...(loopResult.error !== undefined ? { error: loopResult.error } : {}),
    }
  }),
})
