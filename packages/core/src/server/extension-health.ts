import type { ExtensionActorStatusInfo, ExtensionStatusInfo } from "../domain/extension.js"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "./transport-contract.js"

// `ExtensionActorStatusInfo` is a shared domain TaggedEnumClass — transport
// re-exports the same identity rather than maintaining a parallel copy, so
// no wire ↔ domain mapper is needed. For the healthy projections we just
// drop the `failed` variant.
const toHealthyActorStatus = (
  status: ExtensionActorStatusInfo,
): Exclude<ExtensionActorStatusInfo, { readonly _tag: "failed" }> | undefined =>
  status._tag === "failed" ? undefined : status

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
  actorStatuses: ReadonlyArray<ExtensionActorStatusInfo> = [],
): ExtensionHealthSnapshot => {
  const actorByExtension = new Map(
    actorStatuses.map((status) => [status.extensionId, status] as const),
  )

  const extensions = activationStatuses.map((status) => {
    const actorStatus = actorByExtension.get(status.manifest.id)
    const actor = actorStatus !== undefined ? toHealthyActorStatus(actorStatus) : undefined
    const schedulerFailures = status.scheduledJobFailures ?? []
    const actorFailure =
      actorStatus?._tag === "failed"
        ? ExtensionHealthIssue.ActorFailed.make({
            sessionId: actorStatus.sessionId,
            ...(actorStatus.branchId !== undefined ? { branchId: actorStatus.branchId } : {}),
            error: actorStatus.error,
            failurePhase: actorStatus.failurePhase,
            ...(actorStatus.restartCount !== undefined
              ? { restartCount: actorStatus.restartCount }
              : {}),
          })
        : undefined
    const activationFailure =
      status.status === "failed"
        ? ExtensionHealthIssue.ActivationFailed.make({
            phase: status.phase,
            error: status.error,
          })
        : undefined
    const issues = [
      ...(activationFailure !== undefined ? [activationFailure] : []),
      ...(actorFailure !== undefined ? [actorFailure] : []),
      ...schedulerFailures.map((failure) =>
        ExtensionHealthIssue.ScheduledJobFailed.make({
          jobId: failure.jobId,
          error: failure.error,
        }),
      ),
    ]

    const payload = {
      manifest: status.manifest,
      scope: status.scope,
      sourcePath: status.sourcePath,
      ...(actor !== undefined ? { actor } : {}),
    }

    const [firstIssue, ...remainingIssues] = issues
    return firstIssue === undefined
      ? ExtensionHealth.Healthy.make(payload)
      : ExtensionHealth.Degraded.make({
          ...payload,
          issues: [firstIssue, ...remainingIssues],
        })
  })

  const healthyExtensions = extensions.filter(ExtensionHealth.guards.Healthy)
  const degradedExtensions = extensions.filter(ExtensionHealth.guards.Degraded)
  const [firstDegraded, ...remainingDegraded] = degradedExtensions

  return firstDegraded === undefined
    ? ExtensionHealthSnapshot.Healthy.make({ extensions: healthyExtensions })
    : ExtensionHealthSnapshot.Degraded.make({
        healthyExtensions,
        degradedExtensions: [firstDegraded, ...remainingDegraded],
      })
}
