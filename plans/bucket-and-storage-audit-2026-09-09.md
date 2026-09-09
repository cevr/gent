# Extension buckets and storage tags: both axes clean

Date: 2026-09-09
Status: verdict — no removal candidates on either axis.

## Extension contribution buckets

`ExtensionContributions` has eight buckets. A first pass counting static
declarations suggested four were dead (`scheduledJobs`, `hooks`, `modelDrivers`,
`externalDrivers` had producers only in tests).

**That reading was wrong.** Extensions do not populate the buckets directly —
they register at runtime through the host:

| Author API                           | Bucket            | Production sites      |
| ------------------------------------ | ----------------- | --------------------- |
| `host.register("tool", …)`           | `tools`           | 13                    |
| `host.register("request", …)`        | `requests`        | 6                     |
| `host.register("agent", …)`          | `agents`          | 5                     |
| `host.register("resource", …)`       | `resources`       | 3                     |
| `host.register("modelDriver", …)`    | `modelDrivers`    | 1 (+2 provider files) |
| `host.register("job", …)`            | `scheduledJobs`   | 1                     |
| `host.register("externalDriver", …)` | `externalDrivers` | 1                     |
| `host.on(kind, handler)`             | `hooks`           | 5                     |

`modelDrivers` in particular is how every provider ships
(`anthropic/index.ts:305`, `openai/index.ts:321`,
`openai-compatible-driver.ts:107`) — the static-declaration grep missed it
entirely.

Hooks are the one asymmetry: they have no registration _domain_, arriving via
`host.on` instead, with a replay path in `extension-host.ts:152`. Five
production consumers (`skills`, `goal`, root `index.ts`, `cell-extension.ts`).
The asymmetry is inherent — hooks are handlers keyed by kind, not values keyed
by id — so it is not collapsible without inventing a fake id.

Surface is 276 lines total (`contribution.ts` 97 + `extension-host.ts` 179),
with a literal 1:1 `RegistrationDomainMap` and no indirection. Both accessor
helpers (`modelCapabilities`, `rpcCapabilities`) have real callers in
`activation.ts` and `registry.ts`. 20 direct bucket consumers across the
runtime.

**Verdict: already minimal. No candidate.**

## Storage tags

16 files, 4,220 lines. Consumer counts outside each tag's own file:

```
MessageStorage           72    SessionStorage           59
BranchStorage            49    EventStorage             43
SessionOperationStorage  27    CellToolOperationStorage 24
RelationshipStorage      24    InteractionStorage       18
ToolCallBindingStorage   16    CellExecutionStorage     15
CellNamespaceStorage     13    AgentLoopQueueStorage    12
ResourceGraphStorage     11    SearchStorage             7
```

Every tag is load-bearing; the smallest still has 7 production consumers.

**Verdict: no dead surface. No candidate.**

## Method note

The static-declaration grep produced four false positives on the bucket axis
because it measured the wrong thing — where a bucket is _declared_ rather than
where it is _populated_. Extensions populate buckets through `host.register`,
so the producers never appear as `bucketName: [...]` literals.

Same lesson as the retire-mode rejection, one level earlier in the pipeline:
the screen that finds candidates can itself be measuring the wrong signal.
Confirm what a surface's real producer path looks like before trusting a count
of zero.
