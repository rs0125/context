// A 32,000-character source can use six JSON bytes per character. Leave room
// for tool arguments and the RPC envelope; authentication and parsing share this cap.
export const MAX_MCP_BODY_BYTES = 256 * 1024;
