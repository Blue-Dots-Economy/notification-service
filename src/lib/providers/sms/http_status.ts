/**
 * Whether an HTTP status from an SMS vendor is worth another attempt.
 *
 * 5xx may pass. 4xx will not improve, except 408 (request timeout) and 429 (rate
 * limited), which are about timing: failing a rate-limited OTP on its first
 * attempt would turn a brief burst into failed logins.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
