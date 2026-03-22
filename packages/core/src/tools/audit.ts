import { Effect, Schema } from "effect"
import {
  Agents,
  AgentRegistry,
  SubagentRunnerService,
  SubagentError,
  type AgentDefinition,
  type AgentName as AgentNameType,
  type SubagentResult,
} from "../domain/agent.js"
import {
  EventStore,
  WorkflowPhaseStarted,
  WorkflowCompleted,
  type EventEnvelope,
} from "../domain/event.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import { Storage } from "../storage/sqlite-storage.js"
import { runLoop, type LoopVerdict } from "../runtime/loop.js"
import { LoopEvaluationTool } from "./loop.js"

// Audit concern — classified by the detection agent

interface AuditConcern {
  name: string
  description: string
}

// Audit finding — produced by synthesis

interface AuditFinding {
  file: string
  description: string
  severity: "critical" | "warning" | "suggestion"
}

// Schema

export const AuditParams = Schema.Struct({
  prompt: Schema.optional(
    Schema.String.annotate({ description: "Focus area or specific concern" }),
  ),
  paths: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Paths to audit (default: git diff changed files)",
    }),
  ),
  maxIterations: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "Max audit loop iterations (default 3)",
    }),
  ),
  maxConcerns: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 8 })).annotate({
      description: "Max concerns to audit (default 5)",
    }),
  ),
  autoApprove: Schema.optional(
    Schema.Boolean.annotate({ description: "Skip concern approval step" }),
  ),
  mode: Schema.optional(
    Schema.Literals(["fix", "report"]).annotate({
      description: "fix: apply changes, report: findings only (default: fix)",
    }),
  ),
})

// Prompt builders

const buildDetectPrompt = (
  userPrompt: string | undefined,
  paths: ReadonlyArray<string>,
  maxConcerns: number,
) => {
  const pathsList =
    paths.length > 0 ? paths.map((p) => `- ${p}`).join("\n") : "(no paths specified)"
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""

  return `Identify audit concerns for the following code.${focusBlock}
## Paths
${pathsList}

## Instructions
Identify ${maxConcerns} or fewer concern categories. Each concern should be a distinct area of review (e.g., "error handling", "type safety", "performance", "security").

Respond with a numbered list of concerns, each on its own line:
1. <concern name>: <brief description>
2. <concern name>: <brief description>

Be concise. Do not read files — classify based on path names and the focus area.`
}

const parseConcerns = (text: string, maxConcerns: number): AuditConcern[] => {
  const concerns: AuditConcern[] = []
  // Accept: "1. name: desc", "1) name: desc", "- name: desc", "* name: desc", "**name**: desc"
  const pattern = /^(?:\d+[.)]\s*|\s*[-*]\s*)(?:\*\*)?(.+?)(?:\*\*)?:\s*(.+)$/
  for (const line of text.split("\n")) {
    const match = line.match(pattern)
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      concerns.push({ name: match[1].trim(), description: match[2].trim() })
    }
    if (concerns.length >= maxConcerns) break
  }
  return concerns
}

const buildConcernAuditPrompt = (
  concern: AuditConcern,
  paths: ReadonlyArray<string>,
  userPrompt: string | undefined,
) => {
  const pathsList = paths.map((p) => `- ${p}`).join("\n")
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""

  return `Audit the following code for: ${concern.name}
${concern.description}${focusBlock}
## Paths
${pathsList}

## Instructions
Read the relevant files. Identify concrete issues related to "${concern.name}".
For each finding, include the file path and a specific description.
Be thorough but focused on this concern only.`
}

const buildSynthesisPrompt = (
  concernNotes: ReadonlyArray<{ concern: AuditConcern; notes: string }>,
  userPrompt: string | undefined,
) => {
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  const notesBlock = concernNotes
    .map(({ concern, notes }) => `## Concern: ${concern.name}\n${concern.description}\n\n${notes}`)
    .join("\n\n---\n\n")

  return `Synthesize audit findings into an ordered execution plan.${focusBlock}

## Concern Audit Notes
${notesBlock}

## Instructions
1. Deduplicate across concerns
2. Group related findings for coherent fixes
3. Order by dependency, then severity
4. For each finding, specify: file, description, severity (critical/warning/suggestion)

Respond with a numbered list:
1. [severity] file — description
2. [severity] file — description`
}

const parseFindings = (text: string): AuditFinding[] => {
  const findings: AuditFinding[] = []
  const severities = new Set(["critical", "warning", "suggestion"])

  for (const line of text.split("\n")) {
    const match = line.match(/^\d+\.\s*\[(\w+)\]\s*(\S+)\s*[—-]\s*(.+)$/)
    if (
      match !== null &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined
    ) {
      const sev = match[1].toLowerCase()
      findings.push({
        file: match[2].trim(),
        description: match[3].trim(),
        severity: severities.has(sev) ? (sev as AuditFinding["severity"]) : "warning",
      })
    }
  }
  return findings
}

const buildExecutionPrompt = (findings: AuditFinding[], userPrompt: string | undefined) => {
  const focusBlock = userPrompt !== undefined ? `\n## Focus\n${userPrompt}\n` : ""
  const plan = findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.file} — ${f.description}`)
    .join("\n")

  return `Execute this audit plan. Apply the fixes in order.${focusBlock}

## Plan
${plan}

## Instructions
Apply each fix. Related findings may need to be fixed together.
Run validation as needed. Try to complete the whole plan.`
}

const buildEvaluationPrompt = (executionOutput: string) =>
  `Evaluate whether this audit execution resolved all issues or if further iteration is needed.

## Execution Output
${executionOutput}

## Instructions
Assess whether actionable issues remain. Consider:
- Were all planned fixes applied?
- Did fixes introduce new issues?
- Are there remaining items not addressed?

You MUST call the loop_evaluation tool with your verdict:
- verdict: "done" if all issues are resolved
- verdict: "continue" if further iteration is needed
- summary: brief explanation of your decision`

const extractVerdictFromEvents = (
  envelopes: ReadonlyArray<EventEnvelope>,
  resultText: string,
): LoopVerdict => {
  // Only trust input from tool calls that completed successfully
  const succeededCallIds = new Set<string>()
  for (const envelope of envelopes) {
    if (
      (envelope.event._tag === "ToolCallSucceeded" ||
        envelope.event._tag === "ToolCallCompleted") &&
      envelope.event.toolName === "loop_evaluation"
    ) {
      succeededCallIds.add(envelope.event.toolCallId)
    }
  }
  for (const envelope of envelopes) {
    if (
      envelope.event._tag === "ToolCallStarted" &&
      envelope.event.toolName === "loop_evaluation" &&
      envelope.event.input !== undefined &&
      succeededCallIds.has(envelope.event.toolCallId)
    ) {
      const input = envelope.event.input as Record<string, unknown>
      if (input["verdict"] === "done") return "done"
      if (input["verdict"] === "continue") return "continue"
    }
  }

  for (const line of resultText.split("\n")) {
    const trimmed = line.trim().toLowerCase()
    if (trimmed === "verdict: done" || trimmed === "verdict:done") return "done"
    if (trimmed === "verdict: continue" || trimmed === "verdict:continue") return "continue"
  }

  return "continue"
}

const requireText = (result: SubagentResult, label: string) => {
  if (result._tag === "error")
    return Effect.die(new Error(`Audit ${label} failed: ${result.error}`))
  return Effect.succeed(result.text)
}

const successResult = (text: string, sessionId: string, agentName: string): SubagentResult => ({
  _tag: "success",
  text,
  sessionId: sessionId as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never,
  agentName: agentName as AgentNameType,
})

const formatConcernsForApproval = (concerns: AuditConcern[]) =>
  concerns.map((c, i) => `${i + 1}. **${c.name}**: ${c.description}`).join("\n")

// Audit Workflow

export const AuditTool = defineWorkflow({
  name: "audit",
  description:
    "Audit code: detect concerns → parallel audit per concern → synthesize findings → execute fixes → loop until clean. " +
    "Supports fix mode (apply changes) and report mode (findings only).",
  command: "audit",
  phases: ["detect", "approve", "audit", "synthesize", "execute", "evaluate"] as const,
  params: AuditParams,
  execute: Effect.fn("AuditTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const presenter = yield* PromptPresenter
    const registry = yield* AgentRegistry

    const storage = yield* Storage
    const maxIterations = params.maxIterations ?? 3
    const maxConcerns = params.maxConcerns ?? 5
    const mode = params.mode ?? "fix"

    const architectDef = yield* registry.get("architect")
    const architect = architectDef ?? Agents.architect

    const auditorDef = yield* registry.get("auditor")
    const auditor = auditorDef ?? Agents.auditor

    // Resolve caller agent for execution (primary agent, not architect)
    const callerAgent = ctx.agentName ?? "cowork"
    const callerDef = yield* registry.get(callerAgent)
    const executor = callerDef ?? Agents.cowork

    const emitPhase = (phase: string, iteration?: number) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "audit",
            phase,
            ...(iteration !== undefined ? { iteration, maxIterations } : {}),
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const runAgent = (agent: AgentDefinition, prompt: string) =>
      runner.run({
        agent,
        prompt,
        parentSessionId: ctx.sessionId,
        parentBranchId: ctx.branchId,
        toolCallId: ctx.toolCallId,
        cwd: process.cwd(),
      })

    // Get audit paths
    const paths = params.paths ?? []

    // Use runLoop for the audit cycle
    const result = yield* runLoop({
      maxIterations,

      body: (iteration: number, _previousOutput: string) =>
        Effect.gen(function* () {
          // Phase 1: Detect concerns
          yield* emitPhase("detect", iteration)
          const detectResult = yield* runAgent(
            architect,
            buildDetectPrompt(params.prompt, paths, maxConcerns),
          )
          const detectText = yield* requireText(detectResult, "detect")
          const concerns = parseConcerns(detectText, maxConcerns)

          if (concerns.length === 0) {
            return successResult("No concerns detected.", ctx.sessionId, "architect")
          }

          // Phase 2: Approve concerns (unless autoApprove)
          if (params.autoApprove !== true) {
            yield* emitPhase("approve", iteration)
            const approval = yield* presenter
              .confirm({
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
                content: `## Audit Concerns (${concerns.length})\n\n${formatConcernsForApproval(concerns)}\n\nProceed with audit?`,
                title: `Audit Loop ${iteration}/${maxIterations}`,
              })
              .pipe(Effect.catchEager(() => Effect.succeed("no" as const)))
            if (approval === "no") {
              return successResult("Audit cancelled by user.", ctx.sessionId, "architect")
            }
          }

          // Phase 3: Parallel concern audits
          yield* emitPhase("audit", iteration)
          const auditResults = yield* Effect.forEach(
            concerns,
            (concern) => runAgent(auditor, buildConcernAuditPrompt(concern, paths, params.prompt)),
            { concurrency: 3 },
          )
          const concernNotes = concerns.map((concern, i) => {
            const r = auditResults[i]
            return {
              concern,
              notes: r !== undefined && r._tag === "success" ? r.text : "(audit failed)",
            }
          })

          // Phase 4: Synthesize findings
          yield* emitPhase("synthesize", iteration)
          const synthesisResult = yield* runAgent(
            architect,
            buildSynthesisPrompt(concernNotes, params.prompt),
          )
          const synthesisText = yield* requireText(synthesisResult, "synthesize")
          const findings = parseFindings(synthesisText)

          if (findings.length === 0) {
            return successResult(
              `No actionable findings after synthesis.\n\n${synthesisText}`,
              ctx.sessionId,
              "architect",
            )
          }

          // Phase 5: Execute (fix mode only)
          if (mode === "fix") {
            yield* emitPhase("execute", iteration)
            const executionResult = yield* runAgent(
              executor,
              buildExecutionPrompt(findings, params.prompt),
            )
            const executionText = yield* requireText(executionResult, "execute")
            return successResult(executionText, ctx.sessionId, callerAgent)
          }

          // Report mode — return findings without executing
          return successResult(synthesisText, ctx.sessionId, "architect")
        }).pipe(Effect.catchEager((e) => Effect.fail(new SubagentError({ message: String(e) })))),

      evaluate: (_iteration: number, bodyOutput: string) => {
        if (mode === "report") return Effect.succeed("done" as LoopVerdict)
        if (
          bodyOutput.includes("No concerns detected") ||
          bodyOutput.includes("Audit cancelled") ||
          bodyOutput.includes("No actionable findings")
        ) {
          return Effect.succeed("done" as LoopVerdict)
        }
        return emitPhase("evaluate").pipe(
          Effect.andThen(
            runner.run({
              agent: architect,
              prompt: buildEvaluationPrompt(bodyOutput),
              parentSessionId: ctx.sessionId,
              parentBranchId: ctx.branchId,
              toolCallId: ctx.toolCallId,
              cwd: process.cwd(),
              overrides: { additionalTools: [LoopEvaluationTool] },
            }),
          ),
          Effect.flatMap((evalResult) => {
            if (evalResult._tag === "error") return Effect.succeed("done" as LoopVerdict)
            return storage.listEvents({ sessionId: evalResult.sessionId }).pipe(
              Effect.catchEager(() => Effect.succeed([] as ReadonlyArray<EventEnvelope>)),
              Effect.map((envelopes) => extractVerdictFromEvents(envelopes, evalResult.text)),
            )
          }),
          Effect.catchEager(() => Effect.succeed("done" as LoopVerdict)),
        )
      },
    })

    const workflowResult =
      result.reason === "done" ? "success" : result.reason === "error" ? "error" : "max_iterations"

    yield* eventStore
      .publish(
        new WorkflowCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          workflowName: "audit",
          result: workflowResult as "success" | "error" | "max_iterations",
        }),
      )
      .pipe(Effect.catchEager(() => Effect.void))

    return {
      iterations: result.iterations,
      reason: result.reason,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }),
})
