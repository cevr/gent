import { Effect, Option, Schema } from "effect"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionStatus,
  tool,
} from "@gent/core/extensions/api"

// The agent's view of the extensions of its session: which loaded, which
// failed and at what phase, and which the config disables. It reads the
// extension files as they are now, so an extension the agent just wrote shows
// here before the next turn uses it. Every verb uses only the public
// `ExtensionContext`, so a user extension could ship the same ones.

const EXTENSION_ADMIN_EXTENSION_ID = "@gent/extension-admin"

const ExtensionsStatusTool = tool({
  id: "extensions.status",
  readonly: true,
  description:
    "List the extensions of this session: each one's id, scope, source file and state. `Active` names the file version it loaded; `Failed` names the phase that stopped it (`load`: the file did not import; `setup`; `validation`; `startup`: a Resource did not build) and the error; `Disabled` is named by the config's `disabledExtensions`. It loads the extension files as they are now, so call it after you write or edit one to see whether it loads. The next turn uses what it reports.",
  promptSnippet: "List the session's extensions and whether each loaded",
  params: Schema.Struct({
    id: Schema.optionalKey(
      Schema.String.annotate({ description: "Report only the extension with this id." }),
    ),
  }),
  output: Schema.Struct({ extensions: Schema.Array(ExtensionStatus) }),
  execute: (params) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const all = yield* ctx.Extensions.status
      const target = Option.fromUndefinedOr(params.id)
      const extensions = all.filter((status) =>
        Option.match(target, { onNone: () => true, onSome: (id) => status.id === id }),
      )
      return { extensions }
    }),
})

export const ExtensionAdminExtension = defineExtension({
  id: EXTENSION_ADMIN_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ExtensionsStatusTool)
  }),
})
