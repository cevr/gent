/**
 * Stub: no-projection-writes
 *
 * Activates in planify Commit 2 once `ProjectionContribution` exists. Will fail the
 * build if a `ProjectionContribution.query` Effect references a service capability
 * known to perform writes (TaskService.create/update, MemoryVault.set, etc.).
 *
 * Until then, this is a no-op so the rule wiring slot is reserved.
 */
import type { Plugin } from "#oxlint/plugins"

const plugin: Plugin = {
  meta: { name: "gent-projection" },
  rules: {
    "no-projection-writes": {
      create() {
        // Stub — see file header. Activated in Commit 2.
        return {}
      },
    },
  },
}

export default plugin
