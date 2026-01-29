# Actor-Based Agent System for Gent (transfer)

## Checklist

- [x] Add `effect-machine` dependency (catalog + runtime)
- [x] Core agent types/defs/registry/prompts
- [x] Subagent runner interface + errors/results
- [x] Agent events (AgentSwitched/SubagentSpawned/SubagentCompleted)
- [x] ToolContext includes `agentName`
- [x] Remove AgentMode; add SwitchAgent in server/sdk/runtime
- [x] Plan tool (PlanHandler UI + markdown render)
- [x] Task tool (single/parallel/chain)
- [x] Parent session fields + storage migration
- [x] In-process subagent runner + config for subprocess path
- [x] TUI agent picker/status + /agent + Shift+Tab toggle
- [x] Tests updated (api/config/tools)
- [x] Docs updated (ARCHITECTURE/CODE_GUIDE)

## In Progress / Open

- [x] Persist current agent in session state (load last AgentSwitched)
- [x] Surface subagent session hierarchy in UI (palette tree)
- [x] AgentLoop integration decision (keep AgentLoop for primary, AgentActor for subagents)
- [x] Tests for agent switching/subagent events (session agent state covered)
- [x] Wire PlanConfirmed to approvePlan checkpoint

## Notes

- Primary agents: default (opus 4.5), deep (codex 5.2)
- Plan UI should render markdown inline (OpenTUI `<markdown>`)
- Subprocess runner uses config `subprocessBinaryPath` (fallback only for now)
