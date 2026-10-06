export type TemplateErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'unknown_channel'
  | 'vendor_mismatch'
  | 'incomplete_template'
  | 'undeclared_token'
  | 'unused_variable'
  | 'body_too_long'
  | 'missing_variable'
  | 'unknown_variable'
  | 'invalid_variable'
  | 'invalid_contract'
  | 'unknown_content_key'
  | 'content_unavailable'
  | 'content_unresolved'
  | 'invalid_content'
  | 'export_invalid';

/** A template/policy rule violation. Messages name variables, never their values. */
export class TemplateError extends Error {
  constructor(
    public readonly code: TemplateErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
