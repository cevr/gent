import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Option, Predicate, Ref, Schema, Stream } from "effect"
import { defineExtension, tool } from "@gent/core/extensions/api"
import { AgentDefinition, AgentName, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import {
  ChildAgentExtension,
  ChildAgentHandle,
} from "../../../../extensions/src/delegate/child-agent-tools.js"
import { ReadSessionTool } from "../../../../extensions/src/session-tools/read-session.js"
import { LoadedArtifactIdentity, type LoadedExtension } from "@gent/core-internal/domain/extension"
import { ExtensionId, RequestId } from "@gent/core-internal/domain/ids"
import { SteerCommand } from "@gent/core-internal/domain/steer"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { dispatchCell } from "@gent/core-internal/runtime/code-cell/cell-dispatch"
import { CellTool } from "@gent/core-internal/runtime/code-cell/cell-tool"
import { ToolCatalog } from "@gent/core-internal/runtime/code-cell/tool-catalog"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import {
  LanguageModelLayers,
  type SequenceStep,
} from "@gent/core-internal/test-utils/language-model"
import { multiToolCallStep, textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { buildCellExecutable } from "../cell-worker-fixture.js"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

it.live("rejects cell dispatch without a branch owner", () =>
  Effect.gen(function* () {
    const error = yield* dispatchCell().pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: "AgentLoopError",
      message: "Cell execution requires a branch-owned runtime",
    })
  }),
)

describe.skipIf(process.platform !== "darwin")("branch cell lifetime", () => {
  it.scopedLive(
    "controls children across kernel reset and reads a completed child reply",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        const handle = yield* Ref.make(Option.none<typeof ChildAgentHandle.Type>())
        const sources = [
          "const child = await tools.call('agent-start', {agent: 'child', prompt: 'Wait for cancellation'}); await tools.call('child-handle', {_tag: 'save', handle: child}); await tools.call('model-started', {}); true",
          "(await tools.call('agent-child', {_tag: 'inspect', requestId: child.requestId}))._tag === 'pending'",
          "typeof child === 'undefined' && (await tools.call('agent-child', {_tag: 'inspect', requestId: (await tools.call('child-handle', {_tag: 'get'})).requestId}))._tag === 'pending'",
          "const id = (await tools.call('child-handle', {_tag: 'get'})).requestId; await tools.call('agent-child', {_tag: 'cancel', requestId: id}); (await tools.call('agent-child', {_tag: 'wait', requestId: id, waitMs: 2000})).interrupted === true",
          "const finished = await tools.call('agent-start', {agent: 'child', prompt: 'Return the result', overrides: {modelId: 'custom/model', reasoningEffort: 'high', allowedTools: ['read_session'], deniedTools: ['agent-start'], systemPromptAddendum: 'Report the verified result'}}); const observed = await tools.call('agent-child', {_tag: 'wait', requestId: finished.requestId, waitMs: 2000}); const reply = await tools.call('read_session', {sessionId: observed.sessionId, branchId: observed.branchId}); observed._tag === 'completed' && reply.extracted === false && reply.content.includes('verified child result')",
        ]
        const steps = sources.flatMap<SequenceStep>((code, index) => [
          {
            ...toolCallStep("cell", { code, reset: index === 2 }),
            assertOptions: (options) => {
              expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
            },
          },
          textStep(`done-${index}`),
        ])
        steps.splice(1, 0, { ...textStep("child reply"), gated: true })
        steps.splice(10, 0, {
          ...textStep("verified child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            expect(options.tools.map((tool) => tool.name)).toEqual(["read_session"])
            expect(
              options.prompt.content.some(
                (message) =>
                  message.role === "system" &&
                  message.content.includes("Report the verified result"),
              ),
            ).toBe(true)
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(steps)
        const fixture = defineExtension({
          id: "cell-child-fixture",
          agents: [
            new AgentDefinition({ name: DEFAULT_AGENT_NAME }),
            new AgentDefinition({ name: AgentName.make("child") }),
          ],
          tools: [
            CellTool,
            ReadSessionTool,
            tool({
              id: "model-started",
              description: "Wait for the model boundary",
              params: Schema.Struct({}),
              output: Schema.Boolean,
              execute: () => controls.waitForCall(1).pipe(Effect.as(true)),
            }),
            tool({
              id: "child-handle",
              description: "Save or read the test child handle outside the kernel",
              params: Schema.TaggedUnion({ save: { handle: ChildAgentHandle }, get: {} }),
              output: ChildAgentHandle,
              execute: Effect.fn("test.childHandle")(function* (input) {
                if (input._tag === "save") yield* Ref.set(handle, Option.some(input.handle))
                return yield* Effect.fromOption(yield* Ref.get(handle))
              }),
            }),
          ],
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-fixture-source"),
            },
            {
              ...ChildAgentExtension,
              artifactIdentity: LoadedArtifactIdentity.make("child-agent-source"),
            },
          ],
          subagentRunner: "live",
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({
                ...platform,
                cellWorkerPath: Effect.succeed(artifact.binaryPath),
              }),
            ),
          ],
        })
        for (const index of sources.keys()) {
          const content = `cell-child-${index}`
          yield* client.message.send({ sessionId, branchId, content })
          const messages = yield* waitFor(client.message.list({ branchId }), (items) =>
            items.some((item) => item.role === "user" && messageSingleText(item.parts) === content),
          )
          const user = messages.find(
            (item) => item.role === "user" && messageSingleText(item.parts) === content,
          )
          if (Predicate.isUndefined(user)) return yield* Effect.die("Missing parent message")
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          const completed = yield* client.message.list({ branchId })
          const results = completed
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result" && part.name === "cell")
          expect(results.at(-1)).toMatchObject({ isFailure: false, result: { display: "true" } })
        }
        const saved = yield* Effect.fromOption(yield* Ref.get(handle))
        const childMessages = yield* client.message.list({ branchId: saved.branchId })
        expect(childMessages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(yield* controls.callCount).toBe(12)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  it.scopedLive(
    "retains cells across RPC turns, isolates branches, and closes their workers",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        const pids = yield* Ref.make<ReadonlyArray<number>>([])
        const hiddenCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sources = [
              "const catalog = await tools.call('tool-catalog', {_tag: 'search', query: ''}); if (catalog.names.includes('hidden') || !catalog.names.includes('worker')) throw new Error('Wrong catalog'); const spec = await tools.call('tool-catalog', {_tag: 'describe', name: 'worker'}); if (spec.parameters.type !== 'number' || !spec.guidelines.includes('Supply the current worker PID')) throw new Error('Wrong tool description'); let kept = 21; await tools.call('worker', tools.call.constructor('return process.pid')()); kept",
              "kept += 1",
              "await tools.call('worker', tools.call.constructor('return process.pid')()); typeof kept",
              "let rejected = false; try { await tools.call('cell', {code: 'kept = 0'}) } catch (error) { rejected = error.message.includes('A cell cannot invoke another outer cell as a host tool') }; let hiddenRejected = false; try { await tools.call('hidden', {}) } catch { hiddenRejected = true }; rejected && hiddenRejected && kept === 23",
              "typeof kept",
              "await tools.call('worker', tools.call.constructor('return process.pid')()); while (true) {}",
            ]
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(
              sources.flatMap((code, index) => {
                let call = toolCallStep("cell", { code, reset: index === 4 })
                if (index === 1)
                  call = multiToolCallStep(
                    { toolName: "cell", input: { code } },
                    { toolName: "cell", input: { code } },
                  )
                const steps = [call]
                if (index !== 5) steps.push(textStep(`done-${index}`))
                return steps
              }),
            )
            const extensions: ReadonlyArray<LoadedExtension> = [
              {
                manifest: { id: ExtensionId.make("cell-lifetime") },
                scope: "builtin",
                sourcePath: "cell-lifetime",
                artifactIdentity: LoadedArtifactIdentity.make("cell-lifetime-source"),
                contributions: {
                  tools: [
                    tool({
                      id: "hidden",
                      description: "Registered but denied by agent policy",
                      params: Schema.Struct({}),
                      output: Schema.Finite,
                      execute: () => Ref.updateAndGet(hiddenCalls, (count) => count + 1),
                    }),
                    tool({
                      id: "worker",
                      description: "Record worker identity",
                      promptGuidelines: ["Supply the current worker PID"],
                      params: Schema.Finite,
                      output: Schema.Boolean,
                      execute: (pid) =>
                        Ref.update(pids, (values) => [...values, pid]).pipe(Effect.as(true)),
                    }),
                    CellTool,
                    ToolCatalog,
                  ],
                },
              },
            ]
            const { client, sessionId, branchId } = yield* createRpcHarness({
              extensions,
              providerLayer,
              extensionInputs: [],
              agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools: ["hidden"] })],
              extraLayers: [
                Layer.succeed(
                  GentPlatform,
                  GentPlatform.of({
                    ...platform,
                    cellWorkerPath: Effect.succeed(artifact.binaryPath),
                  }),
                ),
              ],
            })
            expect(yield* Ref.get(pids)).toEqual([])
            const second = yield* client.branch.create({ sessionId })
            const branches = [branchId, branchId, second.branchId, branchId, branchId, branchId]
            const expected = ["21", "23", "undefined", "true", "undefined"]
            for (const [index, targetBranch] of branches.entries()) {
              const content = `run-${index}`
              yield* client.message.send({ sessionId, branchId: targetBranch, content })
              const messages = yield* waitFor(
                client.message.list({ branchId: targetBranch }),
                (messages) =>
                  messages.some(
                    (message) =>
                      message.role === "user" && messageSingleText(message.parts) === content,
                  ),
              )
              const user = messages.find(
                (message) =>
                  message.role === "user" && messageSingleText(message.parts) === content,
              )
              if (Predicate.isUndefined(user)) return yield* Effect.die("Missing submitted message")
              if (index === 5) {
                const workers = yield* waitFor(Ref.get(pids), (values) => values.length === 3)
                const pid = workers[2]
                if (Predicate.isUndefined(pid)) return yield* Effect.die("Missing active worker")
                yield* client.steer.command({
                  command: SteerCommand.make({
                    _tag: "Interrupt",
                    sessionId,
                    branchId: targetBranch,
                    requestId: RequestId.make(yield* platform.randomId),
                  }),
                })
                const stopped = yield* waitFor(
                  platform.signal(pid, 0).pipe(Effect.exit),
                  Exit.isFailure,
                  2000,
                  "cancelled worker exit",
                )
                expect(Exit.isFailure(stopped)).toBe(true)
              }
              yield* client.session.events({ sessionId, branchId: targetBranch }).pipe(
                Stream.filter(
                  (envelope) =>
                    envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
                ),
                Stream.take(1),
                Stream.runDrain,
              )
              const completed = yield* client.message.list({ branchId: targetBranch })
              const results = completed
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .filter((part) => part.name === "cell")
              if (index === 1) {
                const repeated = results.slice(-2)
                expect(new Set(repeated.map((part) => part.id)).size).toBe(2)
                expect(repeated).toMatchObject([
                  { isFailure: false, result: { display: "22" } },
                  { isFailure: false, result: { display: "23" } },
                ])
              }
              if (index === 5)
                expect(results.at(-1)).toMatchObject({
                  isFailure: true,
                  result: { _tag: "CellKernelError", reason: "cancelled", stateLost: true },
                })
              else
                expect(results.at(-1)).toMatchObject({
                  isFailure: false,
                  result: { display: expected[index] },
                })
            }
            expect(new Set(yield* Ref.get(pids)).size).toBe(2)
            expect(yield* Ref.get(hiddenCalls)).toBe(0)
          }),
        )
        for (const pid of yield* Ref.get(pids)) {
          expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        }
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})
