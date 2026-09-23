# Contributing to gent

## Development Setup

```bash
git clone https://github.com/cevr/gent.git
cd gent
bun install
bun run gate  # typecheck + lint + fmt + build + test
```

## Conventions

[AGENTS.md](./AGENTS.md) owns the commands, code style, Effect patterns, and
test conventions. [ARCHITECTURE.md](./ARCHITECTURE.md) owns the design; read it
before a significant change and update it in the same commit when the change
diverges from it.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make changes; run `bun run gate`
4. Submit PR — small, reviewable commits preferred over one mega-PR
