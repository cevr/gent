# OAuth + Auth Discipline Plan

## Phase 0 — Audit Findings (sources)

- [ ] Duplicate AgentSwitched event in subagent run (double publish). Refs: `packages/runtime/src/agent/subagent-runner.ts:114`, `packages/runtime/src/agent/subagent-runner.ts:122`
- [ ] ProviderAuth pending OAuth map not session-scoped (overwrites across sessions). Refs: `packages/providers/src/provider-auth.ts:170`, `packages/providers/src/provider-auth.ts:185`
- [ ] OpenAI OAuth server/pending global; timeout does not stop server → leak. Refs: `packages/providers/src/oauth/openai-oauth.ts:182`, `packages/providers/src/oauth/openai-oauth.ts:249`
- [ ] Anthropic OAuth tool-name rewrite is chunk regex → corrupt JSON on chunk splits. Refs: `packages/providers/src/oauth/anthropic-oauth.ts:243`, `packages/providers/src/oauth/anthropic-oauth.ts:254`
- [ ] Env-based auth override still exists; violates curated, minimal config. Refs: `packages/core/src/auth-guard.ts:33`, `packages/providers/src/provider-factory.ts:76`, `packages/core/src/model.ts:58`, `apps/tui/src/main.tsx:121`, `ARCHITECTURE.md:162`
- [ ] Effect Config usage pattern check. Refs: `/Users/cvr/.cache/repo/Effect-TS/effect/packages/effect/src/Config.ts`

## Phase 1 — Decisions (locked)

- [x] OAuth default + API key fallback for Anthropic/OpenAI
- [x] OAuth UX: auto + code (auto default)
- [x] AuthStore layered over AuthStorage
- [x] Model gating for OpenAI OAuth (Codex only)
- [x] Pending OAuth scoped by sessionId + authorizationId
- [x] Stream-safe tool-name rewrite (no chunk regex)
- [x] Remove env-auth override entirely

## Phase 2 — Implementation

- [x] Auth schemas: add `authorizationId` to AuthAuthorization; remove env-only shapes; update exports. Refs: `packages/core/src/auth-method.ts`, `packages/core/src/auth-guard.ts`, `packages/core/src/model.ts`, `packages/core/src/index.ts`
- [x] ProviderAuth: session-scoped pending map keyed by sessionId+provider+method+authorizationId; require authId on callback. Refs: `packages/providers/src/provider-auth.ts`
- [x] OpenAI OAuth: support concurrent pending states, stop server on timeout/empty; no globals leak. Refs: `packages/providers/src/oauth/openai-oauth.ts`
- [x] Anthropic OAuth: stream-safe SSE JSON rewrite for tool names; avoid chunk regex. Refs: `packages/providers/src/oauth/anthropic-oauth.ts`
- [x] ProviderFactory/AuthGuard: remove env fallback; rely on AuthStore only. Refs: `packages/providers/src/provider-factory.ts`, `packages/core/src/auth-guard.ts`
- [x] RPC/SDK/Direct client: add listAuthMethods/authorizeAuth/callbackAuth, add authId threading. Refs: `packages/server/src/rpcs.ts`, `packages/server/src/rpc-handlers.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/direct-client.ts`, `packages/server/src/index.ts`
- [x] TUI auth flow: method selection, auto/code UX, authId threading, no env hints. Refs: `apps/tui/src/routes/auth.tsx`, `apps/tui/src/main.tsx`

## Phase 3 — Tests (regression + goals)

- [x] AuthStore: api+oauth roundtrip + listInfo; AuthGuard uses stored only. Refs: `tests/auth.test.ts`, `tests/core.test.ts`
- [x] ProviderAuth: pending map scoped by sessionId+authId; callback fails without matching authId. Refs: `tests/provider-auth.test.ts`
- [ ] OpenAI OAuth: timeout stops server + pending cleanup (unit). Refs: `packages/providers/src/oauth/openai-oauth.ts`
- [x] Anthropic OAuth: stream-safe rewrite (SSE lines split across chunks). Refs: `tests/provider-auth.test.ts`

## Phase 4 — Verify

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run test`
