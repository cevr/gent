// childTaskText has no product reader here: it writes the text childTaskBody
// reads, so a client test builds a real child task with it, not a copy.
export {
  CHILD_COMPLETION_TYPE,
  ChildCompletionDetails,
  childOutcomeWords,
  childTaskBody,
  childTaskText,
  DELEGATE_EXTENSION_ID,
  readChildCompletionHeadline,
} from "./delegate.js"
export { SkillsRpc } from "./skills.js"
export { FilesRpc } from "./fs-tools.js"
export {
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  GoalRpc,
  GoalSnapshot,
  remainingTokens,
} from "./goal.js"
// forkQuestionText, like childTaskText, has only a test reader here: it
// writes the text forkQuestionBody reads.
export {
  BTW_EXTENSION_ID,
  BTW_QUESTION_TYPE,
  BtwRpc,
  forkQuestionBody,
  forkQuestionText,
  type ForkView as ForkViewType,
} from "./btw.js"
export { AgentsViewRpc, type AgentRowEntry } from "./agents-view.js"
export {
  WAKE_EXTENSION_ID,
  WAKE_MESSAGE_TYPE,
  WakeDetails,
  type WakeEntry as WakeEntryType,
  type WakePending as WakePendingType,
  WakeRpc,
} from "./wake.js"
export {
  SESSION_MESSAGE_TYPE,
  SESSION_TOOLS_EXTENSION_ID,
  SessionMessageDetails,
  sessionMessageBody,
  sessionMessageText,
} from "./session-tools.js"
