/**
 * @gent/skills extension — exposes user/project skills (`.md` files
 * under `~/.claude/skills/` and `<cwd>/.claude/skills/`) to agents.
 *
 * The Skills service is process-scoped. Tools, request RPCs, and the
 * turn projection read it directly; no actor mirror is needed.
 */

import { Effect } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionSetupContext,
  hook,
} from "@gent/core/extensions/api"
import { formatSkillsForPrompt, Skills } from "./skills.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"
import { SkillsRpc } from "./protocol.js"

// ── Extension ──

export const SkillsExtension = defineExtension({
  id: "@gent/skills",
  resources: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      return [
        defineResource({
          tag: Skills,
          scope: "process",
          layer: Skills.Live({ cwd: ctx.cwd, home: ctx.home }),
        }),
      ]
    }),
  hooks: [
    hook.turnProjection(() =>
      Effect.gen(function* () {
        const service = yield* Skills
        const skills = yield* service.list()
        return {
          promptSections: [{ id: "skills", priority: 80, content: formatSkillsForPrompt(skills) }],
        }
      }),
    ),
  ],
  requests: [SkillsRpc.ListSkills, SkillsRpc.GetSkillContent],
  tools: [SkillsTool, SearchSkillsTool],
})
