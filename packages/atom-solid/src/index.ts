// atom.ts
export {
  atom,
  writableAtom,
  state,
  readable,
  map,
  effect,
  type Atom,
  type AtomInstance,
  type Writable,
  type WritableInstance,
} from "./atom"

// registry.ts
export { make, type Registry, type RegistryOptions } from "./registry"

// result.ts
export {
  type Result,
  initial,
  success,
  failure,
  isInitial,
  isSuccess,
  isFailure,
  fromExit,
  waiting,
  waitingFrom,
  match,
  getOrUndefined,
  getOrElse,
} from "./result"

// solid.ts
export {
  RegistryContext,
  useRegistry,
  RegistryProvider,
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
  useAtomSubscribe,
  useAtom,
  useAtomResult,
  type RegistryProviderProps,
} from "./solid"
