import type { AgentName } from "./agent.js"

/**
 * Host-installed periodic work declared by an extension.
 *
 * Today's sole job type is `"headless-agent"`: the scheduler renders a wrapper
 * script that invokes `gent --headless --agent <agent> <prompt>` and registers
 * the script with the OS-level cron daemon.
 */
export interface ScheduledJobContribution {
  /** Extension-local id. Host namespaces with extension id when installing. */
  readonly id: string
  /** Standard cron expression consumed by the host cron runtime. */
  readonly cron: string
  readonly target: {
    readonly agent: AgentName
    readonly prompt: string
    readonly cwd?: string
  }
}
