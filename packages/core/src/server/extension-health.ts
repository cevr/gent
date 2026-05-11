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
        ? ExtensionHealthIssue.cases["activation-failed"].make({
            phase: status.phase,
            error: status.error,
          })
        : undefined
    const issues = [
      ...(activationFailure !== undefined ? [activationFailure] : []),
      ...schedulerFailures.map((failure) =>
        ExtensionHealthIssue.cases["scheduled-job-failed"].make({
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
      ? ExtensionHealth.cases.healthy.make(payload)
      : ExtensionHealth.cases.degraded.make({
          ...payload,
          issues: [firstIssue, ...remainingIssues],
        })
  })

  const healthyExtensions = extensions.filter(ExtensionHealth.guards.healthy)
  const degradedExtensions = extensions.filter(ExtensionHealth.guards.degraded)
  const [firstDegraded, ...remainingDegraded] = degradedExtensions

  return firstDegraded === undefined
    ? ExtensionHealthSnapshot.cases.healthy.make({ extensions: healthyExtensions })
    : ExtensionHealthSnapshot.cases.degraded.make({
        healthyExtensions,
        degradedExtensions: [firstDegraded, ...remainingDegraded],
      })
}
