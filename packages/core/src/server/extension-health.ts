import { Option, Predicate } from "effect"
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
    const schedulerFailures = Option.getOrElse(
      Option.fromUndefinedOr(status.scheduledJobFailures),
      () => [],
    )
    let activationFailure = Option.none<ExtensionHealthIssue>()
    if (status.status === "failed") {
      activationFailure = Option.some(
        ExtensionHealthIssue.cases["activation-failed"].make({
          phase: status.phase,
          error: status.error,
        }),
      )
    }
    const issues = [
      ...Option.match(activationFailure, {
        onNone: () => [],
        onSome: (issue) => [issue],
      }),
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
    if (Predicate.isUndefined(firstIssue)) {
      return ExtensionHealth.cases.healthy.make(payload)
    }
    return ExtensionHealth.cases.degraded.make({
      ...payload,
      issues: [firstIssue, ...remainingIssues],
    })
  })

  const healthyExtensions = extensions.filter(ExtensionHealth.guards.healthy)
  const degradedExtensions = extensions.filter(ExtensionHealth.guards.degraded)
  const [firstDegraded, ...remainingDegraded] = degradedExtensions

  if (Predicate.isUndefined(firstDegraded)) {
    return ExtensionHealthSnapshot.cases.healthy.make({ extensions: healthyExtensions })
  }
  return ExtensionHealthSnapshot.cases.degraded.make({
    healthyExtensions,
    degradedExtensions: [firstDegraded, ...remainingDegraded],
  })
}
