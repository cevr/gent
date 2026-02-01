# Tools

Agent tool definitions. Each tool: params schema, result schema, error type, execute function.

## Tools

| Tool         | File               | Purpose                     |
| ------------ | ------------------ | --------------------------- |
| Read         | `read.ts`          | Read file contents          |
| Write        | `write.ts`         | Write file contents         |
| Edit         | `edit.ts`          | Exact string replacement    |
| Bash         | `bash.ts`          | Shell command execution     |
| Glob         | `glob.ts`          | File pattern matching       |
| Grep         | `grep.ts`          | Content search (ripgrep)    |
| AskUser      | `ask-user.ts`      | Agent asks user questions   |
| RepoExplorer | `repo-explorer.ts` | Clone + explore repos       |
| Todo         | `todo.ts`          | Read/write todo items       |
| WebFetch     | `webfetch.ts`      | Fetch + process web content |
| Plan         | `plan.ts`          | Agent plan presentation     |
| Task         | `task.ts`          | Spawn sub-agent tasks       |

## Pattern

Each tool exports `*Tool` (definition), `*Params` (schema), `*Result` (schema), `*Error` (tagged error).

`AllTools` array in `index.ts` registers all tools for the agent loop.

## Dependencies

- `@gent/core` — `AnyToolDefinition`, schema types
- `@effect/platform` — filesystem, command execution
