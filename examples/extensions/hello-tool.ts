/**
 * Example: Simple tool registration.
 *
 * Place in ~/.gent/extensions/ or .gent/extensions/
 */
import { simpleExtension } from "@gent/core/extensions/api"

export default simpleExtension("hello-tool", (ext) => {
  ext.tool({
    name: "hello",
    description: "Say hello to someone",
    parameters: {
      name: { type: "string", description: "Who to greet" },
    },
    execute: async (params) => `Hello, ${params.name}!`,
  })
})
