/**
 * Example: Simple tool registration.
 *
 * Place in ~/.gent/extensions/ or .gent/extensions/
 */
import { Effect, Schema } from "effect"
import { defineExtension, defineTool, toolContribution } from "@gent/core/extensions/api"

const HelloTool = defineTool({
  name: "hello",
  description: "Say hello to someone",
  params: Schema.Struct({
    name: Schema.String.annotate({ description: "Who to greet" }),
  }),
  execute: (params) => Effect.succeed(`Hello, ${params.name}!`),
})

export default defineExtension({
  id: "hello-tool",
  contributions: () => [toolContribution(HelloTool)],
})
