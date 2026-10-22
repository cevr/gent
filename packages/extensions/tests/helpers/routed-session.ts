/**
 * The routed fake session the threads and machines tests share: the
 * starter's `CALL` lines, the tool results they read, and a home whose roots
 * run one after another over one database file.
 */
import { Effect, Layer, Predicate, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import { BunServices } from "@effect/platform-bun"
import type * as Prompt from "effect/ai/Prompt"
import { BunSqlite } from "@gent/core/host-bun"
import { omitUndefined } from "@gent/core/extensions/api"
import {
  createE2ELayer,
  type createRpcClient,
  finishPart,
  makeTempDirectoryScoped,
  systemTextOf,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core/test-utils"
import { type BranchId, type SessionId, ToolCallId } from "@gent/core/protocol"
import { e2ePreset } from "./test-preset"

export type SessionKey = { readonly sessionId: SessionId; readonly branchId: BranchId }

export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
export const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const billed = (text: string) =>
  Stream.fromIterable([
    textDeltaPart(text),
    finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } }),
  ])

export const toolCalls = (
  calls: ReadonlyArray<{
    readonly tool: string
    readonly id: string
    readonly input: Schema.Json
  }>,
) =>
  Stream.fromIterable([
    ...calls.map((entry) =>
      toolCallPart(entry.tool, entry.input, { toolCallId: ToolCallId.make(entry.id) }),
    ),
    finishPart({ finishReason: "tool-calls", usage: { inputTokens: 50, outputTokens: 10 } }),
  ])

const userIndex = (prompt: Prompt.Prompt) =>
  prompt.content.findLastIndex((message) => message.role === "user")

export const lastUserText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content[userIndex(prompt)]
  if (Predicate.isUndefined(message) || message.role !== "user") return ""
  return message.content
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("\n")
}

/** The model already answered the last user message with a step of its own. */
export const acted = (prompt: Prompt.Prompt) => userIndex(prompt) < prompt.content.length - 1

export const isWorkerRequest = (prompt: Prompt.Prompt) =>
  systemTextOf(prompt).includes("You are a worker thread")

export const starterStep = (prompt: Prompt.Prompt) => {
  const text = lastUserText(prompt)
  if (!text.startsWith("CALL ")) return billed("noted")
  if (acted(prompt)) return billed("done")
  return toolCalls(
    text.split("\n").map((entry) => {
      const [, name = "", id = "", ...rest] = entry.split(" ")
      return { tool: name, id, input: parseJson(rest.join(" ")) }
    }),
  )
}

export type Client = Effect.Success<ReturnType<typeof createRpcClient>>["client"]

export interface SnapshotMessage {
  readonly role: string
  readonly parts: ReadonlyArray<Prompt.Part>
  readonly metadata?: { readonly customType?: string; readonly details?: unknown }
}

/** Every result of one tool call id, in order. */
const toolResults = (messages: ReadonlyArray<SnapshotMessage>, id: string) =>
  messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      if (part.type !== "tool-result" || part.id !== id) return []
      return [{ result: part.result, failed: part.isFailure }]
    })

const callLine = (name: string, id: string, input: Schema.Json) =>
  `CALL ${name} ${id} ${encodeJson(input)}`

type Calls = ReadonlyArray<readonly [tool: string, id: string, input: Schema.Json]>
type Snapshot = Effect.Success<ReturnType<Client["session"]["getSnapshot"]>>

/**
 * Sends the starter its call lines: `ran` holds of a snapshot once its turn
 * is idle and every call has a new result, and `results` reads each call's
 * last result by its id, in order. A test on a virtual clock polls `ran`
 * with its own wait.
 */
export const sendCalls = (client: Client, place: SessionKey, calls: Calls) =>
  Effect.gen(function* () {
    const before = yield* client.session.getSnapshot(place)
    const counts = calls.map(([, id]) => toolResults(before.messages, id).length)
    yield* client.message.send({
      ...place,
      content: calls.map(([name, id, input]) => callLine(name, id, input)).join("\n"),
    })
    return {
      label: `the starter ran ${calls.map(([, id]) => id).join(", ")}`,
      ran: (current: Snapshot) =>
        current.runtime._tag === "Idle" &&
        calls.every(
          ([, id], index) => toolResults(current.messages, id).length > (counts[index] ?? 0),
        ),
      results: (current: Snapshot) =>
        calls.map(([, id]) => toolResults(current.messages, id).at(-1)),
    }
  })

/**
 * The starter makes each call once, in one step, and ends its turn; returns
 * each call's result by its id, in order.
 */
export const call = (client: Client, place: SessionKey, calls: Calls, within = 8_000) =>
  Effect.gen(function* () {
    const sent = yield* sendCalls(client, place, calls)
    const snapshot = yield* waitFor(client.session.getSnapshot(place), sent.ran, within, sent.label)
    return sent.results(snapshot)
  })

export const restartableHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("threads-restart-")
  const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
  const storagePath = `${home}/gent.db`
  const layerFor = (
    providerLayer: Parameters<typeof createE2ELayer>[0]["providerLayer"],
    config: {
      readonly configServiceLayer?: Parameters<typeof createE2ELayer>[0]["configServiceLayer"]
      /** Test extensions beside the shipped ones. */
      readonly extensionInputs?: typeof e2ePreset.extensionInputs
      /** `"catalog"`: the models.dev fixture's models and prices. */
      readonly models?: Parameters<typeof createE2ELayer>[0]["models"]
    } = {},
  ) =>
    createE2ELayer({
      ...e2ePreset,
      ...omitUndefined({ configServiceLayer: config.configServiceLayer, models: config.models }),
      extensionInputs: [...e2ePreset.extensionInputs, ...(config.extensionInputs ?? [])],
      providerLayer,
      storagePath,
      cwd,
      home,
    })
  const sql = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.scoped(
      statement.pipe(
        Effect.provide(BunSqlite.file(storagePath).pipe(Layer.provide(BunServices.layer))),
      ),
    )
  return { layerFor, sql, cwd, home }
})
