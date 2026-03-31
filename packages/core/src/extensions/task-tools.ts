import { extension } from "./api.js"
import { TaskCreateTool } from "../tools/task-create.js"
import { TaskListTool } from "../tools/task-list.js"
import { TaskGetTool } from "../tools/task-get.js"
import { TaskUpdateTool } from "../tools/task-update.js"
import { TaskStopTool } from "../tools/task-stop.js"
import { TaskOutputTool } from "../tools/task-output.js"
import { TaskStorage } from "../storage/task-storage.js"

export const TaskToolsExtension = extension("@gent/task-tools", (ext) => {
  ext.tool(TaskCreateTool)
  ext.tool(TaskListTool)
  ext.tool(TaskGetTool)
  ext.tool(TaskUpdateTool)
  ext.tool(TaskStopTool)
  ext.tool(TaskOutputTool)
  ext.layer(TaskStorage.Live)
})
