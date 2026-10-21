/**
 * The machines extension's client side: no view in the TUI, one `gent ctl`
 * view. `gent ctl status --run <run>` reads one machine run (its state,
 * status, pending action and last steps) as a session of the owner's
 * thread, through `MachinesRpc.Status`, the view `machine.status` gives the
 * model.
 */
import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import { MachinesRpc } from "@gent/extensions/client"
import { ctlProjection, defineClientExtension } from "@gent/tui/extensions"

const statusRef = ref(MachinesRpc.Status)

export default defineClientExtension(statusRef.extensionId, {
  setup: Effect.succeed({}),
  ctl: [
    ctlProjection({
      command: "status",
      flag: "run",
      description: "A machine run's state, status, pending action and last steps (@gent/machines)",
      request: statusRef,
      input: (run) => ({ run }),
    }),
  ],
})
