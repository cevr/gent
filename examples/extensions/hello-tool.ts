/**
 * Example: Simple tool registration.
 *
 * Place in ~/.gent/extensions/ or .gent/extensions/
 */
import { Effect } from "effect"
import { extension } from "@gent/core/extensions/api"

export default extension("hello-tool", ({ ext }) =>
  ext.tools({
    name: "hello",
    description: "Say hello to someone",
    parameters: {
      name: { type: "string", description: "Who to greet" },
    },
    execute: (params) => Effect.succeed(`Hello, ${String(params["name"])}!`),
  }),
)
