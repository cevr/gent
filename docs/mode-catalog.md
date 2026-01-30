# Mode Catalog

Source: `packages/core/src/agent.ts`

## cowork

- Kind: primary
- Purpose: fast execution, minimal prose
- Tools: full access
- Delegates: explore, architect
- Preferred model: openai/opus-4.5

## deep

- Kind: primary
- Purpose: thorough analysis and tradeoffs
- Tools: full access
- Delegates: explore, architect
- Preferred model: openai/codex-5.2

## explore

- Kind: subagent
- Purpose: rapid codebase scanning
- Tools: read, grep, glob, bash
- Preferred model: anthropic/claude-haiku-4

## architect

- Kind: subagent
- Purpose: design approaches, no code changes
- Tools: read, grep, glob, webfetch, websearch
- Preferred model: unspecified (inherits default)

## compaction

- Kind: system
- Hidden: true
- Tools: none

## title

- Kind: system
- Hidden: true
- Tools: none
- Temperature: 0.5
