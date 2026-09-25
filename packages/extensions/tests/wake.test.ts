import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Sink,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { BunServices } from "@effect/platform-bun"
import {
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
  collectTestContributions,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  runToolWithCtx,
  testLeafContext,
  testToolContext,
  turnRequestText,
  RuntimeEnvironment,
} from "@gent/core/test-utils"
import { builtinAgent } from "./helpers/builtin-agents"
import { e2ePreset } from "./helpers/test-preset"
import {
  CancelTool,
  dueAtOf,
  monitorMessage,
  MonitorTool,
  nextDueAt,
  rearmPendingAlarms,
  WAKE_EXTENSION_ID,
  WAKE_MESSAGE_TYPE,
  WakeAlarms,
  WakeAlarmsLive,
  WakeEntry,
  wakeMessage,
  WakePending,
  WakeRpc,
  WakeExtension,
  WakeTool,
} from "../src/wake.js"
import { TestClock } from "effect/testing"
import type { LanguageModel } from "effect/unstable/ai"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import { BranchId, MessageId, SessionId, ToolCallId, SteerCommand } from "@gent/core/protocol"
import {
  RequestId,
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "@gent/core/extensions/api"

/**
 * `wake` is an alarm and `monitor` a poll: the model sets one, answers, and
 * goes idle; when it fires, a user-role `wake` message on the same branch
 * starts the next turn.
 */

const encodeAlarms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(WakeEntry)))

const replyStream = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

interface MessageLike {
  readonly role: string
  readonly metadata?: { readonly customType?: string }
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

const wakeOf = <M extends MessageLike>(messages: ReadonlyArray<M>): Option.Option<M> =>
  Option.fromUndefinedOr(
    messages.find(
      (message) => message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
    ),
  )

const textOf = (message: Option.Option<MessageLike>): string =>
  Option.match(message, {
    onNone: () => "",
    onSome: (value) =>
      value.parts
        .filter((part) => part.type === "text")
        .map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => ""))
        .join(""),
  })

const hasWake = (messages: ReadonlyArray<MessageLike>): boolean => Option.isSome(wakeOf(messages))

const answered = (messages: ReadonlyArray<MessageLike>, text: string): boolean =>
  messages.some((message) => message.role === "assistant" && textOf(Option.some(message)) === text)

/**
 * A first process over a file database answers one turn and stops. `restart`
 * starts a second process over the same database and home, as a server
 * restart would; its loops are cold until something reaches them.
 */
const restartedSession = (home: string) =>
  Effect.gen(function* () {
    const directory = yield* makeTempDirectoryScoped("wake-db-")
    const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
      createE2ELayer({
        ...e2ePreset,
        providerLayer,
        storagePath: `${directory}/gent.db`,
        extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
      })
    const { layer: firstProvider } = yield* LanguageModelLayers.sequence([textStep("hello")])
    const ids = yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(layerFor(firstProvider))
        const { sessionId, branchId } = yield* client.session.create({})
        yield* client.message.send({ sessionId, branchId, content: "hi" })
        yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) => current.runtime._tag === "Idle" && answered(current.messages, "hello"),
          8_000,
          "the first process answered",
        )
        return { sessionId, branchId }
      }),
    )
    const restart = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
      Effect.map(createRpcClient(layerFor(providerLayer)), ({ client }) => client)
    return { ...ids, restart }
  })

describe("wake", () => {
  test("a wake's result reads as its mode, due time, repeat and note, not JSON", () => {
    const summary = (result: {
      readonly wakeId: string
      readonly dueAt: string
      readonly everySeconds?: number
      readonly mode: "wake" | "notify"
      readonly note: string
    }) =>
      toolResultSummary(Option.some(WakeTool), { note: "check CI" }, { isFailure: false, result })
    expect(
      summary({ wakeId: "w1", dueAt: "2026-09-23T10:00:00.000Z", mode: "wake", note: "check CI" }),
    ).toBe("wake at 2026-09-23T10:00:00.000Z · check CI")
    expect(
      summary({
        wakeId: "w2",
        dueAt: "2026-09-23T10:00:00.000Z",
        everySeconds: 60,
        mode: "notify",
        note: "stand up",
      }),
    ).toBe("notify at 2026-09-23T10:00:00.000Z · every 60s · stand up")
    expect(
      summary({ wakeId: "w3", dueAt: "2026-09-23T10:00:00.000Z", mode: "wake", note: "" }),
    ).toBe("wake at 2026-09-23T10:00:00.000Z")
  })

  test("a monitor's result reads as its mode, command, interval, deadline and note, not JSON", () => {
    const summary = (note: string) =>
      toolResultSummary(
        Option.some(MonitorTool),
        { command: "gh run view 1 --exit-status", note },
        {
          isFailure: false,
          result: {
            wakeId: "m1",
            everySeconds: 60,
            deadline: "2026-09-23T10:30:00.000Z",
            mode: "wake",
            note,
          },
        },
      )
    expect(summary("read the log")).toBe(
      "wake · gh run view 1 --exit-status · every 60s until 2026-09-23T10:30:00.000Z · read the log",
    )
    expect(summary("")).toBe(
      "wake · gh run view 1 --exit-status · every 60s until 2026-09-23T10:30:00.000Z",
    )
  })

  it.live("a due time comes from afterSeconds or an ISO time, never both", () =>
    Effect.gen(function* () {
      const now = 1_000_000
      expect(yield* dueAtOf({ afterSeconds: 90 }, now)).toBe(now + 90_000)
      expect(yield* dueAtOf({ at: "1970-01-01T00:20:00.000Z" }, now)).toBe(1_200_000)
      const both = yield* Effect.exit(dueAtOf({ afterSeconds: 1, at: "1970-01-01T00:20:00Z" }, now))
      expect(Exit.isFailure(both)).toBe(true)
      const neither = yield* Effect.exit(dueAtOf({}, now))
      expect(Exit.isFailure(neither)).toBe(true)
      const garbage = yield* Effect.exit(dueAtOf({ at: "tomorrow-ish" }, now))
      expect(Exit.isFailure(garbage)).toBe(true)
      const tooFar = yield* Effect.exit(dueAtOf({ afterSeconds: 25 * 60 * 60 }, now))
      expect(Exit.isFailure(tooFar)).toBe(true)
      const negative = yield* Effect.exit(dueAtOf({ afterSeconds: -5 }, now))
      expect(Exit.isFailure(negative)).toBe(true)
      const past = yield* Effect.exit(dueAtOf({ at: "1970-01-01T00:00:01Z" }, now))
      expect(Exit.isFailure(past)).toBe(true)
      expect(yield* dueAtOf({ afterSeconds: 0 }, now)).toBe(now)
      // An ISO time names a second: the current second is now, the one before is past.
      const midSecond = 1_000_500
      expect(yield* dueAtOf({ at: "1970-01-01T00:16:40Z" }, midSecond)).toBe(midSecond)
      const lastSecond = yield* Effect.exit(dueAtOf({ at: "1970-01-01T00:16:39Z" }, midSecond))
      expect(Exit.isFailure(lastSecond)).toBe(true)
      expect(wakeMessage({ _tag: "alarm", wakeId: "w1", dueAt: 1_200_000, note: "check CI" })).toBe(
        "Alarm w1 fired at 1970-01-01T00:20:00.000Z. check CI",
      )
      const monitor = WakeEntry.cases.monitor.make({
        wakeId: "m1",
        command: "true",
        everySeconds: 1,
        deadline: 0,
        note: "merge it",
      })
      expect(monitorMessage(monitor, "matched", 3, "ok\n")).toBe(
        "Monitor m1 matched after 3 checks of `true`. merge it\n\nLast output:\nok",
      )
      expect(monitorMessage(monitor, "timed-out", 9, "")).toBe(
        "Monitor m1 timed out after 9 checks of `true` without matching. merge it",
      )
      // The next tick is the first one still ahead; missed ticks fold into the fire that happened.
      expect(nextDueAt(1_000, 10, 1_000)).toBe(11_000)
      expect(nextDueAt(1_000, 10, 35_000)).toBe(41_000)
    }),
  )

  it.live(
    "an alarm set mid-turn is listed before the turn ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secondStepStarted = yield* Deferred.make<void>()
          const releaseTurn = yield* Deferred.make<void>()
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 600, mode: "notify", note: "stretch" },
                    { toolCallId: ToolCallId.make("mid-turn-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            // The turn's next step holds until the listing is read.
            return Effect.succeed(
              Stream.fromEffect(
                Deferred.succeed(secondStepStarted, void 0).pipe(
                  Effect.andThen(Deferred.await(releaseTurn)),
                ),
              ).pipe(Stream.flatMap(() => replyStream("set"))),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "remind me" })
          yield* Deferred.await(secondStepStarted)
          const pending = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: WAKE_EXTENSION_ID,
              capabilityId: WakeRpc.Pending.id,
              input: {},
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(WakePending)),
              Effect.timeoutOrElse({
                duration: "2 seconds",
                orElse: () => Effect.die(new Error("wake.pending waited for the turn")),
              }),
            )
          expect(pending.entries).toMatchObject([{ note: "stretch" }])
          yield* Deferred.succeed(releaseTurn, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && answered(current.messages, "set"),
            5_000,
            "the turn ended",
          )
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a notify alarm leaves a notice the user sees at once and the next turn reads, without starting one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{ readonly systemPrompt: string; readonly notices: string }> = []
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            requests.push(turnRequestText(options.prompt))
            calls += 1
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 0.2, mode: "notify", note: "stand up" },
                    { toolCallId: ToolCallId.make("notify-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) return Effect.succeed(replyStream("reminder set"))
            return Effect.succeed(replyStream("read the notice with your prompt"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const list = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: WAKE_EXTENSION_ID,
                capabilityId: WakeRpc.Pending.id,
                input: {},
              })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WakePending)))
          yield* client.message.send({ sessionId, branchId, content: "remind me" })
          // The fire leaves a notice; the loop stays idle and no turn or wake row follows.
          // The fired alarm leaves the file once its notice is in; wait for that settled shape.
          const noticed = yield* waitFor(
            list(),
            (pending) => pending.entries.length === 1 && pending.entries[0]?._tag === "notice",
            5_000,
            "the notice is listed alone",
          )
          expect(noticed.entries).toMatchObject([{ _tag: "notice", note: "stand up" }])
          // The alarm can fire while the turn that set it still ends: wait for that end.
          const idle = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            3_000,
            "the turn that set the alarm ended",
          )
          expect(idle.runtime._tag).toBe("Idle")
          expect(hasWake(idle.messages)).toBe(false)
          // The tool-call step and the reply: nothing after the fire.
          expect(idle.messages.filter((m) => m.role === "assistant").length).toBe(2)
          yield* client.message.send({ sessionId, branchId, content: "what did I miss?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "read the notice with your prompt"),
            8_000,
            "the next turn ran",
          )
          // The notice reached the model after the conversation and left the list.
          expect(hasWake(idle.messages)).toBe(false)
          expect(requests.at(-1)?.notices).toContain("# Notices")
          expect(requests.at(-1)?.notices).toContain("stand up")
          expect(requests.at(-1)?.systemPrompt).toBe(requests[0]?.systemPrompt)
          expect((yield* list()).entries).toEqual([])
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "an idle session wakes at the alarm with the note as a user message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("wake", { afterSeconds: 0.3, note: "check whether CI is green" }),
            textStep("alarm set, going idle"),
            textStep("woke up and checked CI"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "wake me when CI is done" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "woke up and checked CI"),
            8_000,
            "the alarm queued a wake message and the loop answered it",
          )
          expect(textOf(wakeOf(woken.messages)).endsWith("check whether CI is green")).toBe(true)
          // The alarm may fire before the first turn ends; the wake still
          // queues behind that turn's answer.
          const firstAnswer = woken.messages.findIndex(
            (message) =>
              message.role === "assistant" &&
              textOf(Option.some(message)) === "alarm set, going idle",
          )
          const wake = woken.messages.findIndex(
            (message) =>
              message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
          )
          expect(firstAnswer).toBeGreaterThanOrEqual(0)
          expect(wake).toBeGreaterThan(firstAnswer)
          expect(woken.messages.at(-1)?.role).toBe("assistant")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  // No client watches this branch, so nothing but the alarm keeps its loop
  // resident. The cluster passivates a loop idle for a minute, and its branch
  // scope, where the timer runs, closes with it.
  it.scopedLive(
    "an alarm on an idle branch no client watches fires past the idle limit",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("wake", { afterSeconds: 300, note: "check the nightly build" }),
          textStep("alarm set, going idle"),
          textStep("woke up and checked the build"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const turnsCompleted = (count: number) =>
          client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.take(count),
            Stream.runDrain,
            Effect.forkScoped,
          )
        const firstTurn = yield* turnsCompleted(1)
        const wokenTurn = yield* turnsCompleted(2)
        yield* client.message.send({ sessionId, branchId, content: "check the build tonight" })
        yield* Fiber.join(firstTurn)
        // Idle past the entity idle limit, then past the alarm.
        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("6 minutes")
        yield* Fiber.join(wokenTurn)
        expect(yield* controls.callCount).toBe(3)
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(textOf(wakeOf(snapshot.messages)).endsWith("check the nightly build")).toBe(true)
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "a past-due alarm left on disk fires on the first turn after a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-restart-")
          const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("hello again"),
            textStep("checked the build as the alarm asked"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
          })
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(
            `${home}/.gent/wakes/${branchId}.json`,
            encodeAlarms([
              { _tag: "alarm", wakeId: "left-over", dueAt: 1_000, note: "check the build" },
            ]),
          )
          yield* client.message.send({ sessionId, branchId, content: "I'm back" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              current.messages.at(-1)?.role === "assistant",
            8_000,
            "the stored alarm fired and was answered",
          )
          expect(woken.messages.filter((m) => m.role === "assistant").length).toBe(2)
          expect(yield* fs.exists(`${home}/.gent/wakes/${branchId}.json`)).toBe(false)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a stored alarm fires on a resumed branch once it is opened, with no message sent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-open-")
          const { sessionId, branchId, restart } = yield* restartedSession(home)
          const fs = yield* FileSystem.FileSystem
          const file = `${home}/.gent/wakes/${branchId}.json`
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          // Still ahead when the branch opens: the timer itself must come back.
          const dueAt = (yield* Clock.currentTimeMillis) + 1_500
          yield* fs.writeFileString(
            file,
            encodeAlarms([{ _tag: "alarm", wakeId: "ahead", dueAt, note: "check the build" }]),
          )
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("checked the build as the alarm asked"),
          ])
          const client = yield* restart(providerLayer)
          yield* client.session.getSnapshot({ sessionId, branchId })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "checked the build as the alarm asked"),
            8_000,
            "the re-armed alarm woke the branch",
          )
          expect(textOf(wakeOf(woken.messages))).toContain("check the build")
          expect(yield* controls.callCount).toBe(1)
          expect(yield* fs.exists(file)).toBe(false)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "a notify alarm that came due while the process was down shows its notice on open and starts no turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-open-notify-")
          const { sessionId, branchId, restart } = yield* restartedSession(home)
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(
            `${home}/.gent/wakes/${branchId}.json`,
            encodeAlarms([
              { _tag: "alarm", wakeId: "missed", dueAt: 1_000, mode: "notify", note: "stand up" },
            ]),
          )
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
          const client = yield* restart(providerLayer)
          const opened = yield* client.session.getSnapshot({ sessionId, branchId })
          const pending = client.extension
            .request({
              sessionId,
              branchId,
              extensionId: WAKE_EXTENSION_ID,
              capabilityId: WakeRpc.Pending.id,
              input: {},
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WakePending)))
          const shown = yield* waitFor(
            pending,
            (current) => current.entries.some((entry) => entry._tag === "notice"),
            5_000,
            "the notice is listed",
          )
          expect(shown.entries.map((entry) => entry._tag)).toEqual(["notice"])
          const after = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(after.runtime._tag).toBe("Idle")
          expect(after.messages.length).toBe(opened.messages.length)
          expect(yield* controls.callCount).toBe(0)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "an alarm that fired but was not forgotten before a restart does not wake twice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-refire-")
          const { sessionId, branchId, restart } = yield* restartedSession(home)
          const fs = yield* FileSystem.FileSystem
          const file = `${home}/.gent/wakes/${branchId}.json`
          const leftOver = encodeAlarms([
            { _tag: "alarm", wakeId: "left-over", dueAt: 1_000, note: "check the build" },
          ])
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(file, leftOver)
          const woke = yield* LanguageModelLayers.sequence([
            textStep("checked the build as the alarm asked"),
          ])
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* restart(woke.layer)
              yield* waitFor(
                client.session.getSnapshot({ sessionId, branchId }),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  answered(current.messages, "checked the build as the alarm asked"),
                8_000,
                "the stored alarm fired and was answered",
              )
            }),
          )
          // A shutdown between the wake and the forget leaves the fired row on disk.
          yield* fs.writeFileString(file, leftOver)
          const again = yield* LanguageModelLayers.sequence([])
          const settled = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* restart(again.layer)
              yield* client.session.getSnapshot({ sessionId, branchId })
              yield* waitFor(
                fs.exists(file),
                (exists) => !exists,
                8_000,
                "the re-armed alarm fired again and forgot its row, and the file with it",
              )
              // A replayed wake would run its settled message again.
              return yield* waitFor(
                client.session.getSnapshot({ sessionId, branchId }),
                (current) =>
                  current.runtime._tag === "Idle" && current.runtime.queue.followUp.length === 0,
                8_000,
                "the queue drained",
              )
            }),
          )
          expect(yield* woke.controls.callCount).toBe(1)
          expect(yield* again.controls.callCount).toBe(0)
          const wakes = settled.messages.filter(
            (message) =>
              message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
          )
          expect(wakes.length).toBe(1)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "a monitor polls its command until it succeeds, then wakes with the output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* makeTempDirectoryScoped("wake-monitor-")
          const flag = `${dir}/done`
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: `test -f ${flag} && cat ${flag}`,
              everySeconds: 0.1,
              timeoutSeconds: 10,
              note: "read the result file",
            }),
            textStep("watching for the file"),
            textStep("saw the result"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "tell me when it lands" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "watching for the file"),
            5_000,
            "first turn answered",
          )
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(flag, "build 42 green")
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "saw the result"),
            8_000,
            "the monitor matched and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("matched after")
          expect(text).toContain("build 42 green")
          expect(text).toContain("read the result file")
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a monitor that never matches wakes at its deadline and says so",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: "echo still running; false",
              everySeconds: 0.1,
              timeoutSeconds: 0.35,
              note: "give up and report",
            }),
            textStep("watching"),
            textStep("gave up"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "watch it" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "gave up"),
            8_000,
            "the monitor timed out and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("timed out after")
          expect(text).toContain("still running")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

describe("wake.list", () => {
  it.live(
    "the model lists what it armed, with the clock it counts against",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const listed: Array<unknown> = []
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            calls += 1
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 3600, everySeconds: 600, note: "check CI" },
                    { toolCallId: ToolCallId.make("arm-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart("wake.list", {}, { toolCallId: ToolCallId.make("list-1") }),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            for (const message of options.prompt.content) {
              if (message.role !== "tool") continue
              for (const part of message.content) {
                if (part.type === "tool-result" && part.id === "list-1") {
                  listed.push(part.result)
                }
              }
            }
            return Effect.succeed(replyStream("one alarm pending"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "what is armed?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && answered(current.messages, "one alarm pending"),
            8_000,
            "the turn answered",
          )
          expect(listed.length).toBe(1)
          // The model reads ISO times, the same format `wake` returned for this alarm.
          const listing = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              now: Schema.String,
              entries: Schema.Array(
                Schema.TaggedStruct("alarm", {
                  dueAt: Schema.String,
                  everySeconds: Schema.Finite,
                  mode: Schema.String,
                  note: Schema.String,
                }),
              ),
            }),
          )(listed[0])
          expect(listing.entries).toMatchObject([
            { _tag: "alarm", note: "check CI", everySeconds: 600, mode: "wake" },
          ])
          const millis = (iso: string) =>
            Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => NaN)
          const aheadSeconds =
            (millis(listing.entries[0]?.dueAt ?? "") - millis(listing.now)) / 1000
          expect(aheadSeconds).toBeGreaterThan(3500)
          expect(aheadSeconds).toBeLessThanOrEqual(3600)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

/**
 * The wake extension's projection and turn-end hooks over one branch file,
 * run the way a turn runs them. The branch resource failed, so nothing can
 * schedule a stored alarm.
 */
const wakeTurnHooks = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${home}/.gent/wakes/${branchId}.json`
    yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
    const contributions = yield* collectTestContributions(WakeExtension.setup)
    const hooks = contributions.hooks ?? []
    const projection = Option.getOrThrow(
      Option.fromUndefinedOr(
        hooks.find(
          (slot): slot is Extract<typeof slot, { readonly kind: "turnProjection" }> =>
            slot.kind === "turnProjection",
        ),
      ),
    )
    const after = Option.getOrThrow(
      Option.fromUndefinedOr(
        hooks.find(
          (slot): slot is Extract<typeof slot, { readonly kind: "turnAfter" }> =>
            slot.kind === "turnAfter",
        ),
      ),
    )
    const failedAlarms = Layer.succeed(
      WakeAlarms,
      WakeAlarms.of({
        schedule: () => Effect.die("the branch resource failed"),
        cancel: () => Effect.succeed(false),
        pending: Effect.succeed([]),
      }),
    )
    const turnLayer = failedAlarms
    const ctx = testLeafContext({
      ...contextWith(home, yield* Ref.make<ReadonlyArray<string>>([])),
      cwd: home,
    })
    const services = yield* Layer.build(turnLayer)
    const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(WakeEntry)))
    return {
      write: (entries: ReadonlyArray<WakeEntry>) => fs.writeFileString(file, encodeAlarms(entries)),
      stored: Effect.flatMap(readStoredFile(file), decode),
      /** One step's projection: the notice text, and the keys the runtime hands back once read. */
      project: projection.hook.handler({ agent: builtinAgent }).pipe(
        Effect.map((projected) => {
          const notices = projected.notices ?? []
          return {
            text: notices.map((notice) => notice.content).join("\n"),
            keys: notices.flatMap((notice) => notice.keys),
          }
        }),
        Effect.provideService(ExtensionContext, ctx),
        Effect.provideContext(services),
      ),
      /** An answered turn's end, which read `readNotices`. */
      end: (readNotices: ReadonlyArray<string>) =>
        after.hook
          .handler({
            sessionId: SessionId.make("wake-session"),
            branchId,
            messageId: MessageId.make("wake-message"),
            joinedMessageIds: new Set(),
            startedAtMs: 0,
            durationMs: 10,
            agentName: builtinAgent.name,
            interrupted: false,
            streamFailed: false,
            unanswered: false,
            readNotices: new Set(readNotices),
            usage: {
              known: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: Option.none(),
              },
              complete: true,
            },
          })
          .pipe(Effect.provideService(ExtensionContext, ctx), Effect.provideContext(services)),
    }
  })

describe("notices", () => {
  it.live(
    "a notice stays in every step's prompt and survives an interrupted turn; an answered turn clears it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{ readonly systemPrompt: string; readonly notices: string }> = []
          const streaming = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            requests.push(turnRequestText(options.prompt))
            calls += 1
            // Turn 1: set the notify alarm, then reply.
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 0.2, mode: "notify", note: "stand up" },
                    { toolCallId: ToolCallId.make("notify-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) return Effect.succeed(replyStream("reminder set"))
            // Turn 2: held open, then interrupted.
            if (calls === 3) {
              return Deferred.succeed(streaming, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(replyStream("never read")),
              )
            }
            // Turn 3: a tool step, then a reply; both steps must carry the notice.
            if (calls === 4) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 3600, note: "much later" },
                    { toolCallId: ToolCallId.make("later-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            return Effect.succeed(replyStream("read the notice twice"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const list = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: WAKE_EXTENSION_ID,
                capabilityId: WakeRpc.Pending.id,
                input: {},
              })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WakePending)))
          const notices = () =>
            Effect.map(list(), (pending) =>
              pending.entries.filter((entry) => entry._tag === "notice"),
            )
          yield* client.message.send({ sessionId, branchId, content: "remind me" })
          yield* waitFor(notices(), (found) => found.length === 1, 5_000, "the notice is listed")
          yield* client.message.send({ sessionId, branchId, content: "hold on" })
          yield* Deferred.await(streaming)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-holding-turn"),
            }),
          })
          yield* Deferred.succeed(release, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && calls === 3,
            5_000,
            "the held turn ended",
          )
          // The interrupted turn read the notice but did not answer; it stays.
          expect(requests.at(-1)?.notices).toContain("stand up")
          expect((yield* notices()).length).toBe(1)
          yield* client.message.send({ sessionId, branchId, content: "what did I miss?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "read the notice twice"),
            8_000,
            "the answered turn ran",
          )
          expect(requests.length).toBe(5)
          expect(requests[3]?.notices).toContain("stand up")
          expect(requests[4]?.notices).toContain("stand up")
          // The notice never entered the system prompt: every request sent the same one.
          expect(new Set(requests.map((request) => request.systemPrompt)).size).toBe(1)
          yield* waitFor(notices(), (found) => found.length === 0, 5_000, "the notice is cleared")
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  it.live(
    "an answered turn on a branch with no wakes writes no wake file",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-no-file-")
          const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("nothing to wake"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
          })
          yield* client.message.send({ sessionId, branchId, content: "hi" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && answered(current.messages, "nothing to wake"),
            8_000,
            "the turn was answered",
          )
          const fs = yield* FileSystem.FileSystem
          expect(yield* fs.exists(`${home}/.gent/wakes/${branchId}.json`)).toBe(false)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.scopedLive(
    "a failed branch resource still shows the notices, and an answered turn clears only what it showed",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-rearm-failed-")
        const turn = yield* wakeTurnHooks(home)
        yield* turn.write([
          {
            _tag: "notice",
            wakeId: "earlier",
            outcome: "fired",
            firedAt: 1_000,
            content: "Alarm earlier fired. stand up",
            note: "stand up",
          },
          { _tag: "alarm", wakeId: "later", dueAt: Number.MAX_SAFE_INTEGER, note: "much later" },
        ])
        const shown = yield* turn.project
        expect(shown.text).toContain("stand up")
        // A fire the step did not read: its write landed after the projection,
        // though it fired before the turn started.
        yield* turn.write([
          ...(yield* turn.stored),
          {
            _tag: "notice",
            wakeId: "unread",
            outcome: "fired",
            firedAt: 1_000,
            content: "Alarm unread fired. check CI",
            note: "check CI",
          },
        ])
        yield* turn.end(shown.keys)
        // The turn read the earlier notice and answered, so it is gone; the
        // alarm row stays, and so does the notice the turn never showed.
        expect((yield* turn.stored).map((entry) => entry.wakeId)).toEqual(["later", "unread"])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive(
    "a turn end that read no notice keeps them all",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-unanswered-")
        const turn = yield* wakeTurnHooks(home)
        yield* turn.write([
          {
            _tag: "notice",
            wakeId: "earlier",
            outcome: "fired",
            firedAt: 1_000,
            content: "Alarm earlier fired. stand up",
            note: "stand up",
          },
        ])
        expect((yield* turn.project).text).toContain("stand up")
        // The runtime hands back nothing for a turn that did not answer.
        yield* turn.end([])
        expect((yield* turn.stored).map((entry) => entry.wakeId)).toEqual(["earlier"])
        // The next turn shows it again, answers, and clears it.
        const shown = yield* turn.project
        expect(shown.text).toContain("stand up")
        yield* turn.end(shown.keys)
        expect(yield* turn.stored).toEqual([])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
    10_000,
  )

  it.live(
    "a blocked notice an earlier version stored shows in the next turn, and an answered turn clears it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-blocked-once-")
          const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
          const requests: Array<{ readonly systemPrompt: string; readonly notices: string }> = []
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            requests.push(turnRequestText(options.prompt))
            calls += 1
            return Effect.succeed(replyStream(`reply ${calls}`))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
          })
          const fs = yield* FileSystem.FileSystem
          const file = `${home}/.gent/wakes/${branchId}.json`
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(
            file,
            encodeAlarms([
              {
                _tag: "notice",
                wakeId: "old-blocked",
                outcome: "blocked",
                firedAt: 1_000,
                content: "Monitor old-blocked was not re-armed: it was never approved. check",
                note: "check",
              },
            ]),
          )
          const answer = (content: string, reply: string) =>
            client.message
              .send({ sessionId, branchId, content })
              .pipe(
                Effect.andThen(
                  waitFor(
                    client.session.getSnapshot({ sessionId, branchId }),
                    (current) =>
                      current.runtime._tag === "Idle" && answered(current.messages, reply),
                    8_000,
                    `${reply} was answered`,
                  ),
                ),
              )
          yield* answer("I'm back", "reply 1")
          expect(requests[0]?.notices).toContain("never approved")
          // The answered turn cleared the last entry, and the file with it.
          expect(yield* fs.exists(file)).toBe(false)
          yield* answer("anything else?", "reply 2")
          expect(requests[1]?.notices).not.toContain("never approved")
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

// ── wake store ──────────────────────────────────────────────────────────────

/**
 * Alarms live in one file per branch so a restart loses none: the tool writes
 * the file, firing removes the entry, and the next turn re-arms what is left.
 */

const branchId = BranchId.make("wake-branch")

/** The store's read-modify-write cycles serialize under the host's file lock; the bare test lock is a pass-through, so a timer and a cancel would interleave. */
const lockingFileLock = (): ExtensionContextService["FileLock"] => {
  const locks = new Map<string, Semaphore.Semaphore>()
  return {
    withLock: (path, effect) => {
      const lock = Option.fromNullishOr(locks.get(path)).pipe(
        Option.getOrElse(() => {
          const created = Semaphore.makeUnsafe(1)
          locks.set(path, created)
          return created
        }),
      )
      return lock.withPermits(1)(effect)
    },
  }
}

const contextWith = (
  home: string,
  queued: Ref.Ref<ReadonlyArray<string>>,
  fired: Option.Option<Deferred.Deferred<boolean>> = Option.none(),
) =>
  testToolContext({
    FileLock: lockingFileLock(),
    sessionId: SessionId.make("wake-session"),
    branchId,
    toolCallId: ToolCallId.make("tc-wake"),
    home,
    // A monitor runs its command here: a real directory, the test's own.
    cwd: home,
    Session: {
      ...testToolContext().Session,
      // Recording the line and opening the latch in one step lets a test join the
      // fire instead of polling for it.
      send: (params) =>
        Ref.update(queued, (all) => [...all, params.content]).pipe(
          Effect.andThen(
            Option.match(fired, {
              onNone: () => Effect.void,
              onSome: (latch) => Deferred.succeed(latch, true),
            }),
          ),
        ),
    },
  })

/**
 * `WakeAlarms.schedule` drops the id from `pending` only after the fired entry's
 * finalizer rewrote the branch file, so an empty `pending` means the fire fully
 * settled. The finalizer does real file I/O, so the wait is bounded by real
 * time, not by a turn count: two thousand scheduler turns pass in a few
 * milliseconds, and under gate load a write can take longer than that, which
 * is how this wait once reported "still pending" on a fire that was landing.
 * Each turn advances the virtual clock (releases anything sleeping) and then
 * sleeps on the wall clock (lets the I/O land). Exhaustion fails loudly; a
 * silent give-up would let a later assertion read a half-finished fire.
 */
const settled = (
  ids: Effect.Effect<ReadonlyArray<string>>,
  wakeId: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const deadline = wallClock.currentTimeMillisUnsafe() + 5_000
    while (wallClock.currentTimeMillisUnsafe() < deadline) {
      const running = yield* ids
      const done = Option.match(wakeId, {
        onNone: () => running.length === 0,
        onSome: (id) => !running.includes(id),
      })
      if (done) return
      yield* TestClock.adjust("1 milli")
      // gent/no-sleep: allow the wait is for real file I/O, which only the wall clock paces
      yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
    }
    expect("wake timers still pending").toBe("no wake timer pending")
  })

/** The real clock, beside the `TestClock` the alarms run on. */
const wallClock = Clock.Clock.defaultValue()

/** Waits on the wall clock, never the virtual one, for work a `TestClock.adjust` already released. Exhaustion fails loudly. */
const eventually = <A>(read: Effect.Effect<A>, done: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    const deadline = wallClock.currentTimeMillisUnsafe() + 5_000
    while (wallClock.currentTimeMillisUnsafe() < deadline) {
      if (done(yield* read)) return
      // gent/no-sleep: allow the wait is for real file I/O, which only the wall clock paces
      yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
    }
    expect(`still waiting: ${label}`).toBe(label)
  })

/**
 * Moves the virtual clock in small steps until `done` holds. A timer fiber reads
 * the clock and then sleeps; a single `TestClock.adjust` that lands between the
 * two leaves the sleep one whole delay past the new time, and it never wakes.
 * Stepping reaches that timer too. Exhaustion fails loudly.
 */
const advanceUntil = <A>(read: Effect.Effect<A>, done: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    const deadline = wallClock.currentTimeMillisUnsafe() + 5_000
    while (wallClock.currentTimeMillisUnsafe() < deadline) {
      if (done(yield* read)) return
      yield* TestClock.adjust("100 millis")
      // gent/no-sleep: allow the wait is for real file I/O, which only the wall clock paces
      yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
    }
    expect(`still waiting: ${label}`).toBe(label)
  })

/** A branch's wake file as text; a missing file is the empty list, as the store reads it. */
const readStoredFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return "[]"
    return yield* fs.readFileString(file)
  })

const readFile = (home: string) =>
  readStoredFile(`${home}/.gent/wakes/${branchId}.json`).pipe(Effect.provide(BunServices.layer))

/** A branch with no pending entry keeps no file: the empty list is a missing file. */
const wakeFileExists = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(`${home}/.gent/wakes/${branchId}.json`)
  }).pipe(Effect.provide(BunServices.layer))

describe("wake tool claims", () => {
  test("monitor runs shell commands, so it does not claim to be readonly", () => {
    expect(MonitorTool.readonly).toBe(false)
  })

  test("wake and wake.cancel arm and cancel timers, so they do not claim to be readonly", () => {
    expect(WakeTool.readonly).toBe(false)
    expect(CancelTool.readonly).toBe(false)
  })
})

describe("monitor command", () => {
  it.scopedLive(
    "a relative cwd runs in the session directory, not the server directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.realPath(yield* makeTempDirectoryScoped("wake-monitor-cwd-"))
        yield* fs.makeDirectory(`${home}/sub`)
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const fired = yield* Deferred.make<boolean>()
        const ctx = contextWith(home, queued, Option.some(fired))
        yield* runToolWithCtx(
          MonitorTool,
          { command: "pwd", cwd: "sub", everySeconds: 1, timeoutSeconds: 5, note: "where" },
          ctx,
        )
        yield* Deferred.await(fired)
        const [message] = yield* Ref.get(queued)
        expect(message).toContain("matched after")
        expect(message).toContain(`${home}/sub`)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
    10_000,
  )

  it.scopedLive(
    "a hanging command stops at the deadline and the monitor wakes timed out",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-monitor-hang-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const fired = yield* Deferred.make<boolean>()
        const ctx = contextWith(home, queued, Option.some(fired))
        yield* runToolWithCtx(
          MonitorTool,
          { command: "sleep 30", everySeconds: 1, timeoutSeconds: 1, note: "never returns" },
          ctx,
        )
        yield* TestClock.adjust("1 second")
        yield* Deferred.await(fired)
        const [message] = yield* Ref.get(queued)
        // One check: the first `sleep 30` is cut at the deadline, not refused at spawn.
        expect(message).toContain("timed out after 1 checks")
        expect(message).toContain("never returns")
        expect(message).toContain("check still running at deadline")
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
    10_000,
  )
  it.scopedLive("a negative timeout is refused, not timed out at once", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-monitor-negative-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const refused = yield* Effect.exit(
        runToolWithCtx(
          MonitorTool,
          { command: "true", everySeconds: 1, timeoutSeconds: -5, note: "never" },
          contextWith(home, queued, Option.none()),
        ),
      )
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        expect(Cause.pretty(refused.cause)).toContain("timeoutSeconds must not be negative")
      }
      expect(yield* Ref.get(queued)).toEqual([])
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )
})

describe("monitor recovery and deadline", () => {
  it.scopedLive(
    "a stored monitor with a relative cwd re-arms in the session directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.realPath(yield* makeTempDirectoryScoped("wake-rearm-cwd-"))
        yield* fs.makeDirectory(`${home}/sub`)
        yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
        // A row an older binary stored before the cwd was resolved at arm time.
        yield* fs.writeFileString(
          `${home}/.gent/wakes/${branchId}.json`,
          encodeAlarms([
            {
              _tag: "monitor",
              wakeId: "old-relative",
              command: "pwd",
              cwd: "sub",
              everySeconds: 1,
              deadline: 60_000,
              note: "where",
            },
          ]),
        )
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const fired = yield* Deferred.make<boolean>()
        const ctx = testLeafContext(contextWith(home, queued, Option.some(fired)))
        yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
        yield* Deferred.await(fired)
        const [message] = yield* Ref.get(queued)
        expect(message).toContain("matched after")
        expect(message).toContain(`${home}/sub`)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
    10_000,
  )

  it.scopedLive(
    "a check still running at the deadline times out, even when until matches anything",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-monitor-hang-until-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const fired = yield* Deferred.make<boolean>()
        const ctx = contextWith(home, queued, Option.some(fired))
        yield* runToolWithCtx(
          MonitorTool,
          {
            command: "sleep 30",
            until: ".*",
            everySeconds: 1,
            timeoutSeconds: 1,
            note: "never returns",
          },
          ctx,
        )
        yield* TestClock.adjust("1 second")
        yield* Deferred.await(fired)
        const [message] = yield* Ref.get(queued)
        expect(message).toContain("timed out after")
        expect(message).not.toContain("matched after")
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
    10_000,
  )
})

describe("wake store", () => {
  it.scopedLive(
    "an alarm is written to the branch file, and the file goes once its last alarm fires",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-store-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const fired = yield* Deferred.make<boolean>()
        const ctx = contextWith(home, queued, Option.some(fired))
        const handle = yield* runToolWithCtx(
          WakeTool,
          { afterSeconds: 0.2, note: "check the deploy" },
          ctx,
        )
        const stored = yield* readFile(home)
        expect(stored).toContain(handle.wakeId)
        expect(stored).toContain("check the deploy")
        expect(yield* Ref.get(queued)).toEqual([])
        const alarms = yield* WakeAlarms
        yield* TestClock.adjust("200 millis")
        yield* Deferred.await(fired)
        yield* settled(alarms.pending)
        expect((yield* Ref.get(queued)).length).toBe(1)
        expect(yield* wakeFileExists(home)).toBe(false)
      }).pipe(
        // The timer lives in the resource scope; that scope must outlive the tool call.
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  it.scopedLive(
    "a repeating alarm fires on each tick, stores the next one, and stops on cancel",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-repeat-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx = contextWith(home, queued)
        const handle = yield* runToolWithCtx(
          WakeTool,
          { afterSeconds: 1, everySeconds: 2, note: "stretch" },
          ctx,
        )
        expect(handle.everySeconds).toBe(2)
        const alarms = yield* WakeAlarms
        const firedCount = Effect.map(Ref.get(queued), (all) => all.length)
        yield* TestClock.adjust("1 second")
        yield* eventually(firedCount, (count) => count === 1, "first fire")
        // The stored due time moved to the next tick and the timer is still up.
        yield* eventually(
          readFile(home).pipe(Effect.orDie),
          (file) => file.includes(`"dueAt":3000`),
          "next tick",
        )
        expect(yield* alarms.pending).toEqual([handle.wakeId])
        yield* TestClock.adjust("2 seconds")
        yield* eventually(firedCount, (count) => count === 2, "second fire")
        const cancelled = yield* runToolWithCtx(CancelTool, { wakeId: handle.wakeId }, ctx)
        expect(cancelled.cancelled).toEqual([handle.wakeId])
        yield* settled(alarms.pending)
        expect(yield* wakeFileExists(home)).toBe(false)
        yield* TestClock.adjust("4 seconds")
        expect(yield* firedCount).toBe(2)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  // A full follow-up queue refuses the wake line (the exec-tools test fills a
  // real one); the fire must not be lost, so it waits as a notice.
  it.scopedLive("a wake fire the follow-up queue refused is kept as a notice", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-refused-")
      const base = contextWith(home, yield* Ref.make<ReadonlyArray<string>>([]))
      const ctx = {
        ...base,
        Session: {
          ...base.Session,
          send: () =>
            Effect.fail(
              new ExtensionServiceError({
                service: "Session",
                operation: "send",
                message: "Follow-up queue full (max 10)",
              }),
            ),
        },
      }
      const handle = yield* runToolWithCtx(
        WakeTool,
        { afterSeconds: 1, note: "check the deploy" },
        ctx,
      )
      const alarms = yield* WakeAlarms
      yield* TestClock.adjust("1 second")
      yield* settled(alarms.pending)
      const entries = yield* readFile(home).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Array(WakeEntry)))),
        Effect.orDie,
      )
      expect(entries.map((entry) => entry._tag)).toEqual(["notice"])
      const [notice] = entries
      expect(notice?.wakeId).toBe(handle.wakeId)
      if (notice?._tag === "notice") expect(notice.content).toContain("check the deploy")
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("a repeating notify alarm keeps one alarm row and adds one notice per tick", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-repeat-notify-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx = contextWith(home, queued)
      const handle = yield* runToolWithCtx(
        WakeTool,
        { afterSeconds: 1, everySeconds: 2, mode: "notify", note: "stretch" },
        ctx,
      )
      yield* WakeAlarms
      const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(WakeEntry)))
      const stored = readFile(home).pipe(Effect.flatMap(decode), Effect.orDie)
      yield* TestClock.adjust("1 second")
      yield* eventually(
        readFile(home).pipe(Effect.orDie),
        (file) => file.includes(`"dueAt":3000`),
        "tick 1 stored",
      )
      yield* TestClock.adjust("2 seconds")
      yield* eventually(
        readFile(home).pipe(Effect.orDie),
        (file) => file.includes(`"dueAt":5000`),
        "tick 2 stored",
      )
      const entries = yield* stored
      const alarms = entries.filter((entry) => entry._tag === "alarm")
      const notices = entries.filter((entry) => entry._tag === "notice")
      expect(alarms.map((entry) => entry.wakeId)).toEqual([handle.wakeId])
      // The turn notice lists each notice row, so the model reads both ticks.
      expect(notices.length).toBe(2)
      for (const notice of notices) {
        expect(notice.wakeId).toBe(handle.wakeId)
        if (notice._tag === "notice") expect(notice.content).toContain("stretch")
      }
      // Notify mode starts no turn.
      expect(yield* Ref.get(queued)).toEqual([])
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive(
    "a notify tick whose notice was stored before a stop, with its row not yet moved, is not noticed twice on re-arm",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-notify-stop-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx = testLeafContext(contextWith(home, queued))
        const alarm = WakeEntry.cases.alarm.make({
          wakeId: "tick",
          dueAt: 1_000,
          everySeconds: 60,
          mode: "notify",
          note: "stretch",
        })
        // The file a stop leaves between the two writes of an older binary:
        // the notice for due time 1_000 is in, and the row still waits at 1_000.
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
        yield* fs.writeFileString(
          `${home}/.gent/wakes/${branchId}.json`,
          encodeAlarms([
            alarm,
            {
              _tag: "notice",
              wakeId: "tick",
              outcome: "fired",
              firedAt: 1_000,
              content: wakeMessage(alarm),
              note: "stretch",
            },
          ]),
        )
        yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
        yield* TestClock.adjust("1 second")
        yield* eventually(
          readFile(home).pipe(Effect.orDie),
          (file) => file.includes(`"dueAt":61000`),
          "the row moved to the next tick",
        )
        const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(WakeEntry)))
        const entries = yield* readFile(home).pipe(Effect.flatMap(decode), Effect.orDie)
        expect(entries.filter((entry) => entry._tag === "notice")).toHaveLength(1)
        expect(entries.filter((entry) => entry._tag === "alarm")).toHaveLength(1)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  it.scopedLive(
    "an interrupted timer leaves its row for the next re-arm; a settled fire removes it",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-interrupt-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx = contextWith(home, queued)
        const once = yield* runToolWithCtx(WakeTool, { afterSeconds: 5, note: "once" }, ctx)
        const repeat = yield* runToolWithCtx(
          WakeTool,
          { afterSeconds: 1, everySeconds: 2, note: "again" },
          ctx,
        )
        const alarms = yield* WakeAlarms
        const firedCount = Effect.map(Ref.get(queued), (all) => all.length)
        yield* TestClock.adjust("1 second")
        yield* eventually(firedCount, (count) => count === 1, "the repeat fired once")
        yield* eventually(
          readFile(home).pipe(Effect.orDie),
          (file) => file.includes(`"dueAt":3000`),
          "the repeat stored its next tick",
        )
        // A branch close or a shutdown interrupts the timers; the rows must stay.
        expect(yield* alarms.cancel(repeat.wakeId)).toBe(true)
        expect(yield* alarms.cancel(once.wakeId)).toBe(true)
        yield* settled(alarms.pending)
        const file = yield* readFile(home)
        expect(file).toContain(once.wakeId)
        expect(file).toContain(repeat.wakeId)
        expect(file).toContain(`"dueAt":3000`)
        // Re-armed, the one-shot fires and is the only row that leaves.
        yield* rearmPendingAlarms().pipe(
          Effect.provideService(ExtensionContext, testLeafContext(ctx)),
        )
        expect([...(yield* alarms.pending)].sort()).toEqual([once.wakeId, repeat.wakeId].sort())
        yield* advanceUntil(
          Ref.get(queued),
          (all) => all.some((text) => text.endsWith(" once")) && all.length >= 3,
          "the one-shot and the repeat fired",
        )
        yield* settled(alarms.pending, Option.some(once.wakeId))
        expect(yield* readFile(home)).not.toContain(once.wakeId)
        expect(yield* readFile(home)).toContain(repeat.wakeId)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  it.scopedLive("a stored past-due alarm fires on re-arm; a ticking one is not doubled", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-rearm-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const fired = yield* Deferred.make<boolean>()
      const ctx: ExtensionContextService = testLeafContext(
        contextWith(home, queued, Option.some(fired)),
      )
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.gent/wakes/${branchId}.json`,
        encodeAlarms([
          { _tag: "alarm", wakeId: "past", dueAt: 1_000, note: "CI should be done" },
          { _tag: "alarm", wakeId: "later", dueAt: 4_000_000_000_000, note: "tomorrow" },
        ]),
      )
      yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
      const alarms = yield* WakeAlarms
      expect([...(yield* alarms.pending)].sort()).toEqual(["later", "past"])
      // TestClock starts at epoch 0, so the stored dueAt of 1_000 is one second out.
      yield* advanceUntil(Deferred.isDone(fired), (done) => done, "the past-due alarm fired")
      yield* settled(alarms.pending, Option.some("past"))
      expect((yield* Ref.get(queued))[0]).toContain("CI should be done")
      expect(yield* readFile(home)).not.toContain("past")
      expect(yield* readFile(home)).toContain("later")
      yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
      expect(yield* alarms.pending).toEqual(["later"])
      expect(yield* Ref.get(queued)).toHaveLength(1)
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("a re-arm that read an alarm while it fired does not fire it a second time", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-rearm-race-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const firing = yield* Deferred.make<boolean>()
      const release = yield* Deferred.make<boolean>()
      const base = contextWith(home, queued)
      // The first fire holds in its send, so the test decides when it ends.
      const ctx: ExtensionContextService = testLeafContext({
        ...base,
        Session: {
          ...base.Session,
          send: (params) =>
            Ref.getAndUpdate(queued, (all) => [...all, params.content]).pipe(
              Effect.flatMap((before) => {
                if (before.length > 0) return Effect.void
                return Deferred.succeed(firing, true).pipe(Effect.andThen(Deferred.await(release)))
              }),
            ),
        },
      })
      const file = `${home}/.gent/wakes/${branchId}.json`
      // One read of the branch file, once armed, pauses after it returns: the
      // re-arm has seen the alarm and not yet armed it.
      const gateArmed = yield* Ref.make(false)
      const readDone = yield* Deferred.make<boolean>()
      const proceed = yield* Deferred.make<boolean>()
      const fs = yield* FileSystem.FileSystem
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) =>
          fs.readFileString(path, encoding).pipe(
            Effect.tap(() =>
              Ref.getAndSet(gateArmed, false).pipe(
                Effect.flatMap((armed) => {
                  if (!armed || path !== file) return Effect.void
                  return Deferred.succeed(readDone, true).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                  )
                }),
              ),
            ),
          ),
      })
      yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
      yield* fs.writeFileString(
        file,
        encodeAlarms([{ _tag: "alarm", wakeId: "once", dueAt: 1_000, note: "CI should be done" }]),
      )
      const alarms = yield* WakeAlarms
      const rearm = rearmPendingAlarms().pipe(
        Effect.provideService(ExtensionContext, ctx),
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
      )
      yield* rearm
      expect(yield* alarms.pending).toEqual(["once"])
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(firing)
      // A turn's re-arm reads the file while the alarm is still firing.
      yield* Ref.set(gateArmed, true)
      const second = yield* rearm.pipe(Effect.forkScoped)
      yield* Deferred.await(readDone)
      // The fire ends. Where nothing orders it after the re-arm, its entry
      // and its timer are gone before the re-arm goes on.
      yield* Deferred.succeed(release, true)
      yield* settled(alarms.pending).pipe(
        Effect.raceFirst(
          // gent/no-sleep: allow a fire the re-arm holds back never settles; the bound lets the re-arm go on
          Effect.sleep("300 millis").pipe(Effect.provideService(Clock.Clock, wallClock)),
        ),
      )
      yield* Deferred.succeed(proceed, true)
      yield* Fiber.join(second)
      yield* TestClock.adjust("1 second")
      yield* settled(alarms.pending)
      expect(yield* Ref.get(queued)).toHaveLength(1)
      expect(yield* readFile(home)).not.toContain("once")
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive(
    "a monitor row an earlier version stored with a cleared key decodes and re-arms",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-old-cleared-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ran = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx: ExtensionContextService = testLeafContext(contextWith(home, queued))
        // Records each command a monitor spawns and never runs it.
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag === "StandardCommand") {
              yield* Ref.update(ran, (all) => [...all, command.args.join(" ")])
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          }),
        )
        const rearm = rearmPendingAlarms().pipe(
          Effect.provideService(ExtensionContext, ctx),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
        // The schema no longer names `cleared`, so the rows are written as the
        // raw text an earlier version stored.
        const monitor = `"_tag":"monitor","everySeconds":1,"deadline":60000,"note":"check"`
        yield* fs.writeFileString(
          `${home}/.gent/wakes/${branchId}.json`,
          `[{${monitor},"wakeId":"old-cleared","command":"ls build","cleared":true},` +
            `{${monitor},"wakeId":"old-uncleared","command":"ls dist","cleared":false}]`,
        )
        yield* rearm
        const alarms = yield* WakeAlarms
        expect([...(yield* alarms.pending)].sort()).toEqual(["old-cleared", "old-uncleared"])
        yield* eventually(
          Ref.get(ran),
          (all) => all.length >= 2,
          "the armed monitors ran their first check",
        )
        expect(yield* Ref.get(ran)).toContain("-c ls dist")
        const stored = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(WakeEntry)))(
          yield* readFile(home),
        )
        expect(stored.map((entry) => entry._tag)).toEqual(["monitor", "monitor"])
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  it.scopedLive("cancelling stops the timer, removes the file, and nothing fires", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-cancel-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx = contextWith(home, queued)
      const first = yield* runToolWithCtx(WakeTool, { afterSeconds: 0.3, note: "one" }, ctx)
      const second = yield* runToolWithCtx(WakeTool, { afterSeconds: 0.3, note: "two" }, ctx)
      const alarms = yield* WakeAlarms
      expect((yield* alarms.pending).length).toBe(2)
      const one = yield* runToolWithCtx(CancelTool, { wakeId: first.wakeId }, ctx)
      expect(one.cancelled).toEqual([first.wakeId])
      expect(yield* alarms.pending).toEqual([second.wakeId])
      expect(yield* readFile(home)).not.toContain(first.wakeId)
      const rest = yield* runToolWithCtx(CancelTool, {}, ctx)
      expect(rest.cancelled).toEqual([second.wakeId])
      expect(yield* alarms.pending).toEqual([])
      expect(yield* wakeFileExists(home)).toBe(false)
      // Both alarms were due at 0.3s. Past that point nothing may have queued.
      yield* TestClock.adjust("500 millis")
      expect(yield* Ref.get(queued)).toEqual([])
      const missing = yield* runToolWithCtx(CancelTool, { wakeId: "nope" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("cancelling a repeating alarm with unread notices names it once", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-cancel-notices-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx = contextWith(home, queued)
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
      const notice = (firedAt: number): WakeEntry =>
        WakeEntry.cases.notice.make({
          wakeId: "repeating",
          outcome: "fired",
          firedAt,
          content: `stand up (${firedAt})`,
          note: "stand up",
        })
      yield* fs.writeFileString(
        `${home}/.gent/wakes/${branchId}.json`,
        encodeAlarms([
          {
            _tag: "alarm",
            wakeId: "repeating",
            dueAt: 10_000_000,
            everySeconds: 60,
            mode: "notify",
            note: "stand up",
          },
          notice(1_000),
          notice(2_000),
        ]),
      )
      const result = yield* runToolWithCtx(CancelTool, { wakeId: "repeating" }, ctx)
      expect(result.cancelled).toEqual(["repeating"])
      expect(yield* wakeFileExists(home)).toBe(false)
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunServices.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )
})
