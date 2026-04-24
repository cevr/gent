export {
  defineBuiltinResource as defineInternalResource,
  EventPublisher,
  InteractionPendingReader,
  MachineExecute,
  MachineEngine,
  ToolRunner,
  type BuiltinResourceMachine as InternalResourceMachine,
  type BuiltinRuntimeEffect as RuntimeExtensionEffect,
  type ExtensionStorage,
  type InteractionPendingReaderService,
  type PendingInteraction,
  type ToolRunnerService,
} from "../../core/src/extensions/internal.js"
