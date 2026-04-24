import type {
  ExtensionActorStatusInfo as DomainExtensionActorStatusInfo,
  ExtensionStatusInfo,
} from "../domain/extension.js"
import {
  ExtensionActorStatusInfo,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "./transport-contract.js"

const toTransportActorStatus = (status: DomainExtensionActorStatusInfo) => {
  switch (status._tag) {
    case "starting":
      return ExtensionActorStatusInfo.Starting.make(status)
    case "running":
      return ExtensionActorStatusInfo.Running.make(status)
    case "restarting":
      return ExtensionActorStatusInfo.Restarting.make(status)
    case "failed":
      return ExtensionActorStatusInfo.Failed.make(status)
  }
}

const toHealthyTransportActorStatus = (status: DomainExtensionActorStatusInfo) => {
  const actor = toTransportActorStatus(status)
  return actor._tag === "failed" ? undefined : actor
}

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
  actorStatuses: ReadonlyArray<DomainExtensionActorStatusInfo> = [],
): ExtensionHealthSnapshot => {
  const actorByExtension = new Map(
    actorStatuses.map((status) => [status.extensionId, status] as const),
  )

  const extensions = activationStatuses.map((status) => {
    const actorStatus = actorByExtension.get(status.manifest.id)
    const actor = actorStatus !== undefined ? toHealthyTransportActorStatus(actorStatus) : undefined
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
