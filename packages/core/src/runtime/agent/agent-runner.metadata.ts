import { DateTime, Effect, FileSystem } from "effect"
import type { AgentRunToolCall, AgentName, AgentPersistence } from "../../domain/agent.js"
import { AgentRunResult } from "../../domain/agent.js"
import type { EventEnvelope } from "../../domain/event.js"
import type { ToolCallId, SessionId, BranchId } from "../../domain/ids.js"
import type { Message } from "../../domain/message.js"
import {
  messagePartsReasoningLines,
  messagePartsTextLines,
} from "../../domain/message-part-projection.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"

interface ChildMetadata {
  usage?: { input: number; output: number }
  toolCalls?: ReadonlyArray<AgentRunToolCall>
}

interface ChildMetadataAccumulator {
  input: number
  output: number
  started: Map<string, { toolName: string; args: Record<string, unknown> }>
  toolCalls: AgentRunToolCall[]
}

const createChildMetadataAccumulator = (): ChildMetadataAccumulator => ({
  input: 0,
  output: 0,
  started: new Map<string, { toolName: string; args: Record<string, unknown> }>(),
  toolCalls: [],
})

const appendFinishedToolCall = (
  state: ChildMetadataAccumulator,
  toolCallId: ToolCallId,
  toolName: string,
  isError: boolean,
) => {
  const info = state.started.get(toolCallId)
  state.toolCalls.push({
    toolName: info?.toolName ?? toolName,
    args: info?.args ?? {},
    isError,
  })
}

const applyChildMetadataEnvelope = (state: ChildMetadataAccumulator, env: EventEnvelope) => {
  switch (env.event._tag) {
    case "StreamEnded":
      if (env.event.usage !== undefined) {
        state.input += env.event.usage.inputTokens
        state.output += env.event.usage.outputTokens
      }
      return
    case "ToolCallStarted":
      state.started.set(env.event.toolCallId, {
        toolName: env.event.toolName,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
        args: (env.event.input ?? {}) as Record<string, unknown>,
      })
      return
    case "ToolCallSucceeded":
      appendFinishedToolCall(state, env.event.toolCallId, env.event.toolName, false)
      return
    case "ToolCallFailed":
      appendFinishedToolCall(state, env.event.toolCallId, env.event.toolName, true)
      return
  }
}

const finalizeChildMetadata = (state: ChildMetadataAccumulator): ChildMetadata => ({
  ...(state.input > 0 || state.output > 0
    ? { usage: { input: state.input, output: state.output } }
    : {}),
  ...(state.toolCalls.length > 0 ? { toolCalls: state.toolCalls } : {}),
})

const latestAssistantContent = (messages: ReadonlyArray<Message>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== "assistant") continue
    const text = messagePartsTextLines(msg.parts)[0] ?? ""
    const reasoning = messagePartsReasoningLines(msg.parts).join("\n")
    return { text, reasoning }
  }
  return { text: "", reasoning: "" }
}

const collectChildMetadata = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const eventStorage = yield* EventStorage
    return yield* eventStorage.listEvents({ sessionId }).pipe(
      Effect.map((envelopes) => {
        const state = createChildMetadataAccumulator()
        for (const env of envelopes) applyChildMetadataEnvelope(state, env)
        return finalizeChildMetadata(state)
      }),
      Effect.catchEager((e) =>
        Effect.logWarning("failed to collect agent-run metadata").pipe(
          Effect.annotateLogs({ error: String(e) }),
          Effect.as<ChildMetadata>({}),
        ),
      ),
    )
  })

export const loadAgentRunSuccessData = (params: {
  branchId: BranchId
  sessionId: SessionId
  agentName: AgentName
  persistence: AgentPersistence
}) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const messages = yield* messageStorage.listMessages(params.branchId)
    const { text, reasoning } = latestAssistantContent(messages)
    const meta = yield* collectChildMetadata(params.sessionId)
    const success = AgentRunResult.cases.success.make({
      text: text.length > 0 ? text : reasoning,
      sessionId: params.sessionId,
      agentName: params.agentName,
      persistence: params.persistence,
      usage: meta.usage,
      toolCalls: meta.toolCalls,
    })
    return { success, reasoning }
  })

export const saveAgentRunOutput = (result: {
  text: string
  reasoning: string
  agentName: AgentName
  sessionId: SessionId
}) =>
  Effect.gen(function* () {
    const fullContent = [
      result.reasoning.length > 0 ? `## Reasoning\n\n${result.reasoning}\n\n` : "",
      `## Response\n\n${result.text}`,
    ]
      .filter(Boolean)
      .join("")

    if (fullContent.length === 0) return undefined

    const fs = yield* Effect.serviceOption(FileSystem.FileSystem)
    if (fs._tag === "None") return undefined

    const ts = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-")
    const dir = "/tmp/gent/outputs"
    yield* fs.value.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    const safe = result.agentName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
    const filepath = `${dir}/${safe}_${result.sessionId.slice(0, 13)}_${ts}.md`
    const header = `# ${result.agentName} — ${result.sessionId}\n\n`
    return yield* fs.value.writeFileString(filepath, header + fullContent).pipe(
      Effect.as(filepath as string | undefined),
      Effect.orElseSucceed((): string | undefined => undefined),
    )
  })
