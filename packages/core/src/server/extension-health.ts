import type { ExtensionStatusInfo } from "../domain/extension.js"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "./transport-contract.js"

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
): ExtensionHealthSnapshot => {
  const extensions = activationStatuses.map((status) => {
    const schedulerFailures = status.scheduledJobFailures ?? []
    const activationFailure =
      status.status === "failed"
        ? ExtensionHealthIssue.ActivationFailed.make({
            phase: status.phase,
            error: status.error,
          })
        : undefined
    const issues = [
      ...(activationFailure !== undefined ? [activationFailure] : []),
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
