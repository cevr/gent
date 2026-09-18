import { Option, Predicate } from "effect"
import type { ExtensionStatusInfo } from "../domain/extension.js"
import { ExtensionHealth, ExtensionHealthIssue, ExtensionHealthSnapshot } from "./rpc.js"

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
): ExtensionHealthSnapshot => {
  const extensions = activationStatuses.map((status) => {
    let activationFailure = Option.none<ExtensionHealthIssue>()
    if (status.status === "failed") {
      activationFailure = Option.some(
        ExtensionHealthIssue.cases.ActivationFailed.make({
          phase: status.phase,
          error: status.error,
        }),
      )
    }
    const issues = Option.match(activationFailure, {
      onNone: (): ReadonlyArray<ExtensionHealthIssue> => [],
      onSome: (issue) => [issue],
    })

    const payload = {
      manifest: status.manifest,
      scope: status.scope,
      sourcePath: status.sourcePath,
    }

    const [firstIssue, ...remainingIssues] = issues
    if (Predicate.isUndefined(firstIssue)) {
      return ExtensionHealth.cases.Healthy.make(payload)
    }
    return ExtensionHealth.cases.Degraded.make({
      ...payload,
      issues: [firstIssue, ...remainingIssues],
    })
  })

  const healthyExtensions = extensions.filter(ExtensionHealth.guards.Healthy)
  const degradedExtensions = extensions.filter(ExtensionHealth.guards.Degraded)
  const [firstDegraded, ...remainingDegraded] = degradedExtensions

  if (Predicate.isUndefined(firstDegraded)) {
    return ExtensionHealthSnapshot.cases.Healthy.make({ extensions: healthyExtensions })
  }
  return ExtensionHealthSnapshot.cases.Degraded.make({
    healthyExtensions,
    degradedExtensions: [firstDegraded, ...remainingDegraded],
  })
}
