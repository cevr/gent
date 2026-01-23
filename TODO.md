# TODO

Priority: P0 critical, P1 high, P2 medium, P3 low.

- [ ] P0 - Prompt/config wiring + auth/perm persistence
  - Rationale: baseline correctness; current prompt ignores AGENTS/skills/config; perms in-memory only
  - Research: `packages/server/src/system-prompt.ts` (prompt assembly), `packages/core/src/skills.ts` (skills load/format), `packages/runtime/src/config-service.ts` (user/project config), `packages/core/src/auth-storage.ts` (keychain/file), `packages/core/src/permission.ts` + `packages/core/src/permission-handler.ts` (policy + UI flow), `packages/server/src/index.ts` (dependency wiring), `packages/server/src/core.ts` (sendMessage path)
  - External refs: `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/rules.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/config.mdx`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/README.md`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/skills.md`
  - Touch: `packages/server/src/system-prompt.ts`, `packages/server/src/index.ts`, `packages/runtime/src/config-service.ts`, `packages/core/src/skills.ts`, `packages/core/src/permission.ts`, `packages/core/src/auth-storage.ts`, maybe new `packages/runtime/src/prompt-loader.ts`
  - Plan needs: config precedence rules; AGENTS/CLAUDE/SYSTEM/APPEND behavior; where to persist permission rules; UX for permission decisions; tests in `tests/` + `apps/tui/tests/`

- [x] P1 - Session lifecycle UX (compact, tree nav, branch summaries, resume)
  - Rationale: long-session viability; parity with pi/opencode
  - Research: `packages/runtime/src/checkpoint.ts` (compaction), `packages/runtime/src/agent-loop.ts` (checkpoint use), `packages/storage/src/sqlite-storage.ts` (checkpoints/branches), `packages/core/src/event.ts` (Compaction*, Plan*, Todo*), `apps/tui/src/routes/session.tsx` (slash cmds + stream), `apps/tui/src/commands/slash-commands.ts` (compact stub)
  - External refs: `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/compaction.md`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/tree.md`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/sessions.mdx` (if added), `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/share.mdx`
  - Touch: `apps/tui/src/routes/session.tsx`, `apps/tui/src/commands/slash-commands.ts`, `packages/server/src/core.ts` (compact/branch ops), `packages/server/src/operations.ts` + `packages/server/src/rpcs.ts` (new RPCs), `packages/storage/src/sqlite-storage.ts` (if new queries)
  - Plan needs: UX flow for `/compact`, `/tree`, `/fork`; summary prompt; branch selection UI; event shapes; migration plan if new tables/fields

- [ ] P2 - Provider/model management (registry, custom providers, auth flows)
  - Rationale: model agility; onboarding
  - Research: `packages/providers/*` (ai-sdk adapters), `packages/runtime/src/model-registry.ts` (model list cache), `packages/runtime/src/config-service.ts` (model storage), `packages/core/src/model.ts` (pricing), `packages/core/src/auth-storage.ts` (keys)
  - External refs: `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/README.md` (models/providers), `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/providers.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/models.mdx`
  - Touch: `packages/runtime/src/model-registry.ts`, `packages/runtime/src/config-service.ts`, `packages/providers/src/provider.ts`, `apps/tui/src/components/model-picker.tsx` (if exists), `packages/server/src/core.ts` (model list RPC)
  - Plan needs: model source of truth; custom provider config format; auth key resolution (env vs storage); UX for model switch; tests for registry cache

- [ ] P2 - Advanced tooling (LSP, git diff/revert, attachments, UI polish)
  - Rationale: productivity + trust signals
  - Research: `packages/tools/src/*` (current tools), `packages/core/src/tool.ts` (tool schema), `apps/tui/src/components/*` (rendering), opencode docs: LSP, diff/revert flows
  - External refs: `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/lsp.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/tools.mdx`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md`
  - Touch: `packages/tools/src/lsp.ts` (new), `packages/tools/src/git.ts` (new), `apps/tui/src/routes/session.tsx` (render new tool output), `packages/core/src/event.ts` (new events if needed)
  - Plan needs: scope of tools; permission rules; output size handling; UI affordances

- [ ] P3 - Extensibility (plugins/custom tools/skills loader/MCP optional)
  - Rationale: ecosystem; keep core minimal
  - Research: `packages/core/src/skills.ts` (already), `packages/tools/src/index.ts` (tool registry), `packages/runtime/src/agent-loop.ts` (tool filtering), opencode docs: plugins/tools/MCP; pi docs: extensions/skills
  - External refs: `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/plugins.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/custom-tools.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/mcp-servers.mdx`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/skills.md`
  - Touch: new `packages/runtime/src/extension-loader.ts`, `packages/tools/src/registry.ts` (if dynamic), `packages/server/src/index.ts` (wiring), `apps/tui/src/routes/session.tsx` (skill command UI)
  - Plan needs: extension API surface; sandboxing; discovery paths; loading order; security model

- [ ] P3 - Server/SDK/headless (true SSE, richer HTTP, CLI)
  - Rationale: multi-client + automation; lower priority now
  - Research: `packages/server/src/http-api.ts` (current), `apps/server/src/main.ts` (SSE stub), `packages/server/src/rpcs.ts` (RPC), `apps/tui/src/client/*` (RPC usage), opencode/pi docs for SDK/RPC patterns
  - External refs: `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/server.mdx`, `~/.cache/repo/anomalyco/opencode/packages/web/src/content/docs/sdk.mdx`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/rpc.md`, `~/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/sdk.md`
  - Touch: `apps/server/src/main.ts`, `packages/server/src/http-api.ts`, `packages/server/src/operations.ts`, `packages/server/src/rpc-handlers.ts`, new `apps/cli/` (headless), maybe `packages/sdk/`
  - Plan needs: streaming protocol choice (SSE vs WS); auth; versioning; API surface; CLI UX + flags; tests for streaming
