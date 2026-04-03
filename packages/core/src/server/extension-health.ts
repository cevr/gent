import type { ExtensionActorStatusInfo, ExtensionStatusInfo } from "../domain/extension.js"
import type { ExtensionHealthSnapshot } from "./transport-contract.js"

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
  actorStatuses: ReadonlyArray<ExtensionActorStatusInfo> = [],
): ExtensionHealthSnapshot => {
  const actorByExtension = new Map(
    actorStatuses.map((status) => [status.extensionId, status] as const),
  )

  const extensions = activationStatuses.map((status) => {
    const actor = actorByExtension.get(status.manifest.id)
    const schedulerFailures = status.scheduledJobFailures ?? []
    const activation =
      status.status === "failed"
        ? {
            status: "failed" as const,
            ...(status.phase !== undefined ? { phase: status.phase } : {}),
            ...(status.error !== undefined ? { error: status.error } : {}),
          }
        : { status: "active" as const }
    const degraded =
      status.status === "failed" || actor?.status === "failed" || schedulerFailures.length > 0

    return {
      manifest: status.manifest,
      kind: status.kind,
      sourcePath: status.sourcePath,
      status: degraded ? ("degraded" as const) : ("healthy" as const),
      activation,
      ...(actor !== undefined ? { actor } : {}),
      scheduler: {
        status: schedulerFailures.length > 0 ? ("degraded" as const) : ("healthy" as const),
        failures: schedulerFailures,
      },
    }
  })

  const failedExtensions = extensions
    .filter((status) => status.activation.status === "failed")
    .map((status) => status.manifest.id)
  const failedActors = extensions
    .filter((status) => status.actor?.status === "failed")
    .map((status) => status.manifest.id)
  const failedScheduledJobs = extensions.flatMap((status) =>
    status.scheduler.failures.map((failure) => `${status.manifest.id}:${failure.jobId}`),
  )

  let subtitle: string | undefined
  if (failedExtensions.length > 0) {
    subtitle = "extension activation degraded"
  } else if (failedActors.length > 0) {
    subtitle = "extension runtime degraded"
  } else if (failedScheduledJobs.length > 0) {
    subtitle = "scheduled jobs degraded"
  }

  return {
    extensions,
    summary: {
      status:
        failedExtensions.length > 0 || failedActors.length > 0 || failedScheduledJobs.length > 0
          ? ("degraded" as const)
          : ("healthy" as const),
      ...(subtitle !== undefined ? { subtitle } : {}),
      failedExtensions,
      failedActors,
      failedScheduledJobs,
    },
  }
}
