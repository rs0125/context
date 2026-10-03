/** Mailbox failures are not failures of the employee's Context Engine grant.
 * Keep recovery machine-readable and derived from known internal codes; never
 * promote provider text, URLs, or arbitrary GMAIL_* codes into instructions.
 */
export function gmailReadError(code: string) {
  const recovery = (retryable: boolean, action: string, guidance: string) => ({
    domain: 'gmail' as const, recovery: { retryable, action, guidance },
  });
  switch (code) {
    case 'GMAIL_CONNECT_REQUIRED':
      return recovery(false, 'connect_gmail', 'Read get_email_connection and use its connection link to connect your work Gmail account. Other Context Engine tools may still be used.');
    case 'GMAIL_RECONNECT_REQUIRED':
    case 'GMAIL_AUTH_REQUIRED':
      return recovery(false, 'reconnect_gmail', 'Read get_email_connection and use its connection link to reconnect the same work Gmail account. Other Context Engine tools may still be used.');
    case 'GMAIL_REVOCATION_PENDING':
      return recovery(false, 'finish_gmail_disconnect', 'Read get_email_connection and use its connection link to finish disconnecting before reconnecting Gmail.');
    case 'GMAIL_CONNECTION_CHANGED':
      return recovery(false, 'check_gmail_connection', 'Read get_email_connection to verify the current mailbox. Recover an earlier operation only with the same account and original operation reference.');
    case 'GMAIL_DRAFT_UNAVAILABLE':
    case 'GMAIL_NOT_FOUND':
      return recovery(false, 'check_gmail_draft', 'This draft is unavailable. Check Gmail Drafts or list_email_drafts for your application-created references. Do not infer that a missing draft was sent or automatically create a replacement.');
    case 'GMAIL_RESPONSE_TOO_LARGE':
      return recovery(false, 'check_gmail_draft', 'The saved draft exceeds the supported read size. Review it in Gmail; do not repeat this read unchanged or create a replacement.');
    case 'GMAIL_INVALID_INPUT':
    case 'GMAIL_INVALID_CURSOR':
      return recovery(false, 'correct_query', 'Use the tool schema and unchanged draft references or pagination cursors returned by the application.');
    case 'GMAIL_ACCESS_DENIED':
      return recovery(false, 'check_google_access', 'Check the connected work Gmail account and its draft permission. Read get_email_connection for the connection link.');
    case 'GMAIL_CONFIGURATION':
    case 'GMAIL_ENCRYPTION_CONFIGURATION':
      return recovery(false, 'check_source_configuration', 'An administrator must check the Gmail connection configuration. Do not repeat this read unchanged.');
    case 'GMAIL_RATE_LIMITED':
    case 'GMAIL_TIMEOUT':
    case 'GMAIL_UNAVAILABLE':
    case 'GMAIL_OAUTH_UNAVAILABLE':
    case 'GMAIL_STORAGE_UNAVAILABLE':
      return recovery(true, 'retry_later', 'Retry the same read after the indicated delay. If Gmail remains unavailable, report that limitation; no draft content was verified.');
    case 'GMAIL_ABORTED':
    case 'GMAIL_RESPONSE_INVALID':
      return recovery(false, 'investigate_source_response', 'No draft content was verified. Check the saved draft in Gmail before relying on it.');
    default:
      // In particular, roster changes and employee/key denials keep the engine's
      // authorization semantics even when detected inside a Gmail operation.
      return undefined;
  }
}
