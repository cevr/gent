/**
 * Example: Session-scoped dynamic capabilities.
 *
 * Demonstrates the public authoring loop for capabilities that appear only
 * after runtime state says they should exist:
 *   - process-scoped extension state
 *   - one slash-presented installer request
 *   - one session-scoped dynamic tool
 *   - one session-scoped dynamic slash request
 */
import { Context, Effect, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  defineRequests,
  defineStateResource,
  ExtensionContext,
  ExtensionId,
  request,
  tool,
  type ExtensionState,
} from "@gent/core/extensions/api"

const DYNAMIC_SCRATCHPAD_ID = ExtensionId.make("dynamic-scratchpad")

interface ScratchpadState {
  readonly entries: ReadonlyArray<string>
}

class ScratchpadStateResource extends Context.Service<
  ScratchpadStateResource,
  ExtensionState<ScratchpadState>
>()("gent/examples/extensions/dynamic-scratchpad/ScratchpadStateResource") {}

const appendInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Scratchpad entry to append" }),
})

const appendOutput = Schema.Struct({
  count: Schema.Number,
  latest: Schema.String,
})

export const ScratchpadAppendTool = tool({
  id: "scratchpad_append",
  description: "Append a note to the session scratchpad",
  params: appendInput,
  output: appendOutput,
  promptSnippet: "Append short session-local scratchpad notes.",
  execute: ({ text }) =>
    Effect.gen(function* () {
      const state = yield* ScratchpadStateResource
      return yield* state.modify((current) => [
        { count: current.entries.length + 1, latest: text },
        { entries: [...current.entries, text] },
      ])
    }),
})

export const DynamicScratchpadRequests = defineRequests(DYNAMIC_SCRATCHPAD_ID, {
  ShowScratchpad: request({
    id: "scratchpad-show",
    slash: {
      trigger: "scratchpad",
      name: "Scratchpad",
      description: "Show dynamic scratchpad entries for this session",
      category: "Session",
    },
    description: "Show dynamic scratchpad entries",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () =>
      Effect.gen(function* () {
        const state = yield* ScratchpadStateResource
        const snapshot = yield* state.get
        if (snapshot.entries.length === 0) return "Scratchpad is empty."
        return snapshot.entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
      }),
  }),
})

export const InstallScratchpadRequest = request({
  id: "scratchpad-install",
  slash: {
    trigger: "scratchpad-install",
    name: "Install Scratchpad",
    description: "Register scratchpad capabilities for this session",
    category: "Session",
  },
  description: "Register scratchpad capabilities for this session",
  input: Schema.Struct({}),
  output: Schema.Struct({
    tool: Schema.String,
    request: Schema.String,
  }),
  execute: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const unregisterTool = yield* ctx.Dynamic.registerTool(
        DYNAMIC_SCRATCHPAD_ID,
        ScratchpadAppendTool,
      )
      const unregisterRequest = yield* ctx.Dynamic.registerRequest(
        DYNAMIC_SCRATCHPAD_ID,
        DynamicScratchpadRequests.ShowScratchpad,
      )
      void unregisterTool
      void unregisterRequest
      return { tool: "scratchpad_append", request: "scratchpad-show" }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityError({
            extensionId: DYNAMIC_SCRATCHPAD_ID,
            capabilityId: "scratchpad-install",
            reason: cause.message,
          }),
      ),
    ),
})

export default defineExtension({
  id: DYNAMIC_SCRATCHPAD_ID,
  resources: [
    defineStateResource({
      tag: ScratchpadStateResource,
      scope: "process",
      initial: { entries: [] },
    }),
  ],
  requests: [InstallScratchpadRequest],
})
