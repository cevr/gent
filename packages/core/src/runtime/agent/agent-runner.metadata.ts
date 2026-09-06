import { DateTime, Effect, FileSystem, Match, Option, Predicate, Schema } from "effect"
import type {
  AgentRunResult as AgentRunResultType,
  AgentRunToolCall,
  AgentName,
  AgentPersistence,
} from "../../domain/agent.js"
import { AgentRunResult, AgentRunToolCallSchema } from "../../domain/agent.js"
import type { EventEnvelope } from "../../domain/event.js"
import type { ToolCallId, SessionId, BranchId } from "../../domain/ids.js"
import type { Message } from "../../domain/message.js"
import {
  messagePartsReasoningLines,
  messagePartsTextLines,
} from "../../domain/message-part-projection.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import type { StorageError } from "../../domain/storage-error.js"

type AgentRunSuccess = Extract<AgentRunResultType, { readonly _tag: "success" }>

const decodeToolArgs = Schema.decodeUnknownOption(AgentRunToolCallSchema.fields.args)

export interface AgentRunMetadataRuntime {
  readonly loadAgentRunSuccessData: (params: {
    branchId: BranchId
    sessionId: SessionId
    agentName: AgentName
    persistence: AgentPersistence
  }) => Effect.Effect<{ success: AgentRunSuccess; reasoning: string }, StorageError, never>
  readonly saveAgentRunOutput: (result: {
    text: string
    reasoning: string
    agentName: AgentName
    sessionId: SessionId
  }) => Effect.Effect<Option.Option<string>>
}

interface ChildMetadata {
  usage?: { input: number; output: number }
  toolCalls?: ReadonlyArray<AgentRunToolCall>
}

interface ChildMetadataAccumulator {
  input: number
  output: number
  started: Map<string, Pick<AgentRunToolCall, "toolName" | "args">>
  toolCalls: AgentRunToolCall[]
}

const createChildMetadataAccumulator = (): ChildMetadataAccumulator => ({
  input: 0,
  output: 0,
  started: new Map(),
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

const applyChildMetadataEnvelope = (state: ChildMetadataAccumulator, env: EventEnvelope) =>
  Match.value(env.event).pipe(
    Match.tag("StreamEnded", ({ usage }) => {
      if (Predicate.isNotUndefined(usage)) {
        state.input += usage.inputTokens
        state.output += usage.outputTokens
      }
    }),
    Match.tag("ToolCallStarted", (event) => {
      state.started.set(event.toolCallId, {
        toolName: event.toolName,
        args: Option.getOrElse(decodeToolArgs(event.input), () => ({})),
      })
    }),
    Match.tag("ToolCallSucceeded", (event) =>
      appendFinishedToolCall(state, event.toolCallId, event.toolName, false),
    ),
    Match.tag("ToolCallFailed", (event) =>
      appendFinishedToolCall(state, event.toolCallId, event.toolName, true),
    ),
    Match.orElse(() => {}),
  )

const finalizeChildMetadata = (state: ChildMetadataAccumulator): ChildMetadata => {
  const metadata: ChildMetadata = {}
  if (state.input > 0 || state.output > 0) {
    metadata.usage = { input: state.input, output: state.output }
  }
  if (state.toolCalls.length > 0) metadata.toolCalls = state.toolCalls
  return metadata
}

const latestAssistantContent = (messages: ReadonlyArray<Message>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (Predicate.isUndefined(msg) || msg.role !== "assistant") continue
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
    let responseText = text
    if (responseText.length === 0) responseText = reasoning
    const success = AgentRunResult.cases.success.make({
      text: responseText,
      sessionId: params.sessionId,
      agentName: params.agentName,
      persistence: params.persistence,
      usage: meta.usage,
      toolCalls: meta.toolCalls,
    })
    return { success, reasoning }
  })

export const makeAgentRunMetadataRuntime: Effect.Effect<
  AgentRunMetadataRuntime,
  never,
  EventStorage | MessageStorage
> = Effect.gen(function* () {
  const eventStorage = yield* EventStorage
  const messageStorage = yield* MessageStorage
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem)

  const saveAgentRunOutput = (result: {
    text: string
    reasoning: string
    agentName: AgentName
    sessionId: SessionId
  }) =>
    Effect.gen(function* () {
      if (Option.isNone(fs)) return Option.none<string>()
      let fullContent = `## Response\n\n${result.text}`
      if (result.reasoning.length > 0) {
        fullContent = `## Reasoning\n\n${result.reasoning}\n\n${fullContent}`
      }

      const ts = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-")
      const dir = "/tmp/gent/outputs"
      yield* fs.value.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
      const safe = result.agentName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
      const filepath = `${dir}/${safe}_${result.sessionId.slice(0, 13)}_${ts}.md`
      const header = `# ${result.agentName} — ${result.sessionId}\n\n`
      return yield* fs.value
        .writeFileString(filepath, header + fullContent)
        .pipe(Effect.as(Option.some(filepath)), Effect.orElseSucceed(Option.none<string>))
    })

  return {
    loadAgentRunSuccessData: (params) =>
      loadAgentRunSuccessData(params).pipe(
        Effect.provideService(EventStorage, eventStorage),
        Effect.provideService(MessageStorage, messageStorage),
      ),
    saveAgentRunOutput,
  }
})
