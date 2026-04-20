/**
 * Debug / test provider re-exports.
 *
 * The implementations live in `providers/provider.ts` (as static methods
 * on the `Provider` class). This barrel re-exports the standalone
 * functions for backwards compatibility with existing `import { ... }
 * from "@gent/core/debug/provider"` call sites.
 *
 * Prefer `Provider.Sequence`, `Provider.Debug`, `Provider.Signal`,
 * `Provider.Failing` for new code.
 *
 * @module
 */

export {
  textStep,
  toolCallStep,
  textThenToolCallStep,
  multiToolCallStep,
  type SequenceStep,
  type SequenceProviderControls,
  type SignalProviderControls,
} from "../providers/provider.js"

// Re-export under legacy names for backwards compat with existing imports
import { Provider } from "../providers/provider.js"

/** @deprecated Use `Provider.Debug()` */
export const DebugProvider = Provider.Debug

/** @deprecated Use `Provider.Failing` */
export const DebugFailingProvider = Provider.Failing

/** @deprecated Use `Provider.Signal(...)` */
export const createSignalProvider = Provider.Signal

/** @deprecated Use `Provider.Sequence(...)` */
export const createSequenceProvider = Provider.Sequence
