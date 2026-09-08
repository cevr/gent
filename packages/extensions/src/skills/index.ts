/**
 * @gent/skills extension — exposes user/project skills (`.md` files
 * under `~/.claude/skills/` and `<cwd>/.claude/skills/`) to agents.
 *
 * The Skills service is process-scoped. Request RPCs and the
 * turn projection read it directly; no actor mirror is needed.
 */

import { Effect } from "effect"
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api"
import { formatSkillsForPrompt, Skills } from "./skills.js"
import { SkillsRpc } from "./protocol.js"

// ── Extension ──

export const SkillsExtension = defineExtension({
  id: "@gent/skills",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/skills/service",
        tag: Skills,
        scope: "process",
        layer: Skills.Live({ cwd: host.cwd, home: host.home }),
      }),
    )
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const service = yield* Skills
        const skills = yield* service.list
        return {
          promptSections: [{ id: "skills", priority: 80, content: formatSkillsForPrompt(skills) }],
        }
      }),
    )
    yield* host.register("request", SkillsRpc.ListSkills, SkillsRpc.GetSkillContent)
  }),
})
