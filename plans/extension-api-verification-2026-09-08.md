# Extension API verification — 2026-09-08

Claude completed the server registration API collapse. It did not complete every
step in the original seven-step proposal.

| Plan step                                 | Verified result                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. One registration host                  | Complete. `ExtensionHost.register(domain, ...values)` and `on(kind, handler)` are present.                                                                                             |
| 2. Migrate builtins, remove compatibility | Complete. `defineExtension` accepts only `id` and `setup`. Old bucket keys fail. Builtins use the new host. The old input normalizers and setup context are absent from active source. |
| 3. Single execution wrapper               | Complete. Tools, requests, and hooks use `provideExtensionLeaf`. The separate hook-context module is absent.                                                                           |
| 4. Reuse host context                     | Resolved by the recorded design change. One host context is built per run. No separate per-branch facet cache was added.                                                               |
| 5. Move tool metadata off the brand       | Deferred. Tools still use Effect AI tools with Gent metadata annotations. `DynamicExtensionRegistry` remains a separate service.                                                       |
| 6. Per-extension scopes and close/reload  | Dropped by the recorded design decision. Profile refresh runs setup again. Resource lifetimes remain under the resource graph. This is not per-registration scope removal.             |
| 7. Derive slash commands                  | Complete. The TUI builds command entries from server `listSlashCommands`. Custom UI commands remain separate.                                                                          |

The new public entry point is strict. Internal `ExtensionContributions` records
remain as the compiled representation. Those internal records are not an old
public authoring compatibility path.

The TUI still has its own `defineClientExtension` and client contribution types.
The plan retained client extensions for custom UI. The Herdr plugin uses that
existing TUI path. Its client-provider scope is separate from the dropped
server per-registration scope proposal.

Claude's final report at transcript line 15992 names commits `f4e077c6`,
`6dec5c19`, and `a04c84f0`. They are ancestors of the current checkout. The
plan's detailed Status section agrees with the code. Its old top line still
said “proposal, not scheduled”; this verification corrects that line.

The full gate passed during Herdr work. It includes `define-extension.test.ts`,
which verifies registration and rejects old bucket keys.

## Sources

- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/17f27525-938e-4ff3-bd2f-e538f846be84.jsonl:15992`
- `/Users/cvr/Developer/personal/gent/plans/extension-registration-collapse.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/btw/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts`
- `/tmp/gent-herdr-gate.log`
