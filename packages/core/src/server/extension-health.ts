import type {
  ExtensionActorStatusInfo as DomainExtensionActorStatusInfo,
  ExtensionStatusInfo,
} from "../domain/extension.js"
import {
  ExtensionActivationHealth,
  ExtensionActorStatusInfo,
  ExtensionHealth,
  ExtensionHealthSummary,
  ExtensionSchedulerHealth,
  type ExtensionHealthSnapshot,
  type ScheduledJobFailureInfo,
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

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
  actorStatuses: ReadonlyArray<DomainExtensionActorStatusInfo> = [],
): ExtensionHealthSnapshot => {
  const actorByExtension = new Map(
    actorStatuses.map((status) => [status.extensionId, status] as const),
  )

  const extensions = activationStatuses.map((status) => {
    const actorStatus = actorByExtension.get(status.manifest.id)
    const actor = actorStatus !== undefined ? toTransportActorStatus(actorStatus) : undefined
    const schedulerFailures = status.scheduledJobFailures ?? []
    const activation =
      status.status === "failed"
        ? ExtensionActivationHealth.Failed.make({
            phase: status.phase,
            error: status.error,
          })
        : ExtensionActivationHealth.Active.make({})
    const degraded =
      status.status === "failed" || actor?._tag === "failed" || schedulerFailures.length > 0
    const [
      firstSchedulerFailure,
      ...remainingSchedulerFailures
    ]: ReadonlyArray<ScheduledJobFailureInfo> = schedulerFailures
    const scheduler =
      firstSchedulerFailure !== undefined
        ? ExtensionSchedulerHealth.Degraded.make({
            failures: [firstSchedulerFailure, ...remainingSchedulerFailures],
          })
        : ExtensionSchedulerHealth.Healthy.make({})

    const payload = {
      manifest: status.manifest,
      scope: status.scope,
      sourcePath: status.sourcePath,
      activation,
      ...(actor !== undefined ? { actor } : {}),
      scheduler,
    }

    return degraded ? ExtensionHealth.Degraded.make(payload) : ExtensionHealth.Healthy.make(payload)
  })

  const failedExtensions = extensions
    .filter((status) => status.activation._tag === "failed")
    .map((status) => status.manifest.id)
  const failedActors = extensions
    .filter((status) => status.actor?._tag === "failed")
    .map((status) => status.manifest.id)
  const failedScheduledJobs = extensions.flatMap((status) =>
    status.scheduler._tag === "degraded"
      ? status.scheduler.failures.map((failure) => `${status.manifest.id}:${failure.jobId}`)
      : [],
  )

  let subtitle: string | undefined
  if (failedExtensions.length > 0) {
    subtitle = "extension activation degraded"
  } else if (failedActors.length > 0) {
    subtitle = "extension runtime degraded"
  } else if (failedScheduledJobs.length > 0) {
    subtitle = "scheduled jobs degraded"
  }

  const summary =
    failedExtensions.length > 0 || failedActors.length > 0 || failedScheduledJobs.length > 0
      ? ExtensionHealthSummary.Degraded.make({
          ...(subtitle !== undefined ? { subtitle } : {}),
          failedExtensions,
          failedActors,
          failedScheduledJobs,
        })
      : ExtensionHealthSummary.Healthy.make({})

  return {
    extensions,
    summary,
  }
}
