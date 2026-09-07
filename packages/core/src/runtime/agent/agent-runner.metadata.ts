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
  usage: Option.Option<{ input: number; output: number }>
  sawStream: boolean
  started: Map<string, Pick<AgentRunToolCall, "toolName" | "args">>
  toolCalls: AgentRunToolCall[]
}

const createChildMetadataAccumulator = (): ChildMetadataAccumulator => ({
  usage: Option.some({ input: 0, output: 0 }),
  sawStream: false,
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
      state.sawStream = true
      if (Option.isNone(state.usage)) return
      if (
        Predicate.isUndefined(usage) ||
        !Number.isSafeInteger(usage.inputTokens) ||
        !Number.isSafeInteger(usage.outputTokens) ||
        usage.inputTokens < 0 ||
        usage.outputTokens < 0
      ) {
        state.usage = Option.none()
        return
      }
      const input = state.usage.value.input + usage.inputTokens
      const output = state.usage.value.output + usage.outputTokens
      state.usage = Option.none()
      if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) {
        state.usage = Option.some({ input, output })
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
  if (state.sawStream && Option.isSome(state.usage)) {
    metadata.usage = state.usage.value
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

const collectChildMetadata = (sessionId: SessionId, branchId: BranchId) =>
  Effect.gen(function* () {
    const eventStorage = yield* EventStorage
    return yield* eventStorage.listEvents({ sessionId, branchId }).pipe(
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
    const meta = yield* collectChildMetadata(params.sessionId, params.branchId)
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
