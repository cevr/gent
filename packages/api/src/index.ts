// Operations (shared schemas)
export {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SendMessagePayload,
  ListMessagesPayload,
  MessageInfo,
  SteerPayload,
  SubscribeEventsPayload,
} from "./operations.js"

// RPC definitions
export { GentRpcs, type GentRpcsClient } from "./rpcs.js"

// HTTP API (legacy, will be derived from operations in future)
export {
  GentApi,
  SessionsApi,
  MessagesApi,
  EventsApi,
  SendMessageRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  SteerRequest,
} from "./http-api.js"
