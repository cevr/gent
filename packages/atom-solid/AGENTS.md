# Atom-Solid

Reactive atom primitives bridging Effect services with Solid.js signals.

## Modules

| File          | Purpose                                                     |
| ------------- | ----------------------------------------------------------- |
| `atom.ts`     | Core atom type — reactive container for async Effect values |
| `registry.ts` | Atom registry for deduplication + lifecycle management      |
| `result.ts`   | Result type for atom states (loading/success/error)         |
| `solid.ts`    | Solid.js integration — `useAtom`, `useAtomValue` hooks      |

## Dependencies

- `effect` — Effect runtime
- `solid-js` — reactive signals
