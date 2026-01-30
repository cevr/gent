# Mode Catalog

Source: `packages/core/src/agent.ts` (AgentDefinitions + AgentModels)

## cowork

- Kind: primary
- Purpose: fast execution, minimal prose
- Tools: full access
- Delegates: explore, architect
- Curated model: openai/opus-4.5

## deep

- Kind: primary
- Purpose: thorough analysis and tradeoffs
- Tools: full access
- Delegates: explore, architect
- Curated model: openai/codex-5.2

## explore

- Kind: subagent
- Purpose: rapid codebase scanning
- Tools: read, grep, glob, bash
- Curated model: anthropic/claude-3-5-haiku-20241022

## architect

- Kind: subagent
- Purpose: design approaches, no code changes
- Tools: read, grep, glob, webfetch, websearch
- Curated model: openai/opus-4.5

## compaction

- Kind: system
- Hidden: true
- Tools: none
- Curated model: anthropic/claude-3-5-haiku-20241022

## title

- Kind: system
- Hidden: true
- Tools: none
- Temperature: 0.5
- Curated model: anthropic/claude-3-5-haiku-20241022
