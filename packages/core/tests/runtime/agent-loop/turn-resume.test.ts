/**
 * Resume from the durable turn record.
 *
 * A turn's position is one row: the step whose messages committed, the
 * continuations it has spent, and the tool calls the current step has not
 * settled. These tests drive the loop through a real step boundary and
 * assert the row that boundary wrote, then restart the whole process over
 * the same database and assert the turn finishes without re-running a tool
 * whose result already committed.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { Database } from "bun:sqlite"
import { Gent } from "@gent/sdk"
import { LoadedArtifactIdentity, type LoadedExtension } from "../../../src/domain/extension.js"
import { ExtensionId } from "../../../src/domain/ids"
import { createE2ELayer } from "../../../src/test-utils/e2e-layer"
import { makeTempDirectoryScoped, waitFor } from "../../../src/test-utils/fixtures"
import { LanguageModelLayers } from "../../../src/test-utils/language-model"
import { textStep, toolCallStep } from "../../../src/test-utils/sequence-steps"
import { e2ePreset } from "../../../../extensions/tests/helpers/test-preset"

const TurnRecordRow = Schema.Struct({
  step: Schema.Finite,
  continuations: Schema.Finite,
  pending_tool_calls_json: Schema.String,
})

const decodePendingJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
)

/**
 * Read the turn row straight from the database file. The test asserts what a
 * restarting process would see, so it must not read through a live layer.
 */
const readTurnRecordRow = Effect.fn("test.readTurnRecordRow")(function* (params: {
  readonly dbPath: string
  readonly sessionId: string
  readonly branchId: string
  readonly messageId: string
}) {
  const raw = yield* Effect.sync(() => {
    const db = new Database(params.dbPath, { readonly: true })
    const rows = db
      .query(
        "SELECT step, continuations, pending_tool_calls_json FROM turn_records WHERE session_id = ? AND branch_id = ? AND message_id = ?",
      )
      .all(params.sessionId, params.branchId, params.messageId)
    db.close()
    return rows[0]
  })
  const row = yield* Schema.decodeUnknownEffect(TurnRecordRow)(raw)
  const pendingToolCalls = yield* decodePendingJson(row.pending_tool_calls_json)
  return { step: row.step, continuations: row.continuations, pendingToolCalls }
})

/** Counts real executions across both processes; two layer graphs, one box. */
const probe = { runs: 0 }

const ResumeProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/turn-resume-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/turn-resume-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "resume_probe",
        description: "Record one execution and echo the label",
        params: Schema.Struct({ label: Schema.String }),
        output: Schema.Struct({ label: Schema.String, run: Schema.Finite }),
        execute: Effect.fn("resume_probe")(function* (params) {
          yield* ExtensionContext
          probe.runs += 1
          return { label: params.label, run: probe.runs }
        }),
      }),
    ],
  },
}

/** The user message id that opened the branch's only turn. */
const openingTurnMessageId = (messages: ReadonlyArray<{ readonly id: string }>) =>
  messages.map((message) => message.id).find((id) => !id.includes(":"))

describe("turn record", () => {
  it.scopedLive(
    "records the completed step for a turn that answered after a tool call",
    () =>
      Effect.gen(function* () {
        probe.runs = 0
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-record-")
        const dbPath = `${tempDir}/gent.db`
        const provider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "one" }),
          textStep("DONE-AFTER-TOOL"),
        ])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer: provider.layer,
            extensions: [ResumeProbeExtension],
            storagePath: dbPath,
          }),
        )
        const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
        // The turn is done only when `TurnCompleted` lands: the reply text is
        // durable before the final step boundary writes the record.
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "run the probe" })
        yield* Fiber.join(completed)
        const messages = yield* client.message.list({ branchId })
        const messageId = openingTurnMessageId(messages)
        expect(messageId).toBeDefined()

        const record = yield* readTurnRecordRow({
          dbPath,
          sessionId,
          branchId,
          messageId: messageId ?? "",
        })
        // Two steps ran: the tool call and the answer. Both closed.
        expect(record.step).toBe(2)
        expect(record.pendingToolCalls).toEqual([])
        expect(record.continuations).toBe(0)
        expect(probe.runs).toBe(1)
      }).pipe(Effect.timeout("20 seconds")),
    40_000,
  )

  it.scopedLive(
    "finishes an interrupted turn from the record without re-running a settled tool",
    () =>
      Effect.gen(function* () {
        probe.runs = 0
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-resume-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "RESUMED-REPLY"

        // First process: the tool call settles, then the model is asked
        // again. The scope closes while that second call is gated, so the
        // turn never finalizes.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "first" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            yield* client.message
              .send({ sessionId, branchId, content: "run the resume probe" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )
        expect(probe.runs).toBe(1)

        // Second process: the same database, a model that only answers. The
        // settled tool call must not run a second time.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        expect(probe.runs).toBe(1)
      }),
    60_000,
  )
})
