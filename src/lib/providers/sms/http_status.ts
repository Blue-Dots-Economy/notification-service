/**
 * Whether an HTTP status from an SMS vendor is worth another attempt.
 *
 * 5xx is the vendor's problem and may pass. 4xx is our request and will not
 * improve — EXCEPT the two that are explicitly about timing rather than
 * content: 408 (request timeout) and 429 (rate limited). Both retried before
 * this classification existed, and dead-lettering a rate-limited OTP on its
 * first attempt would turn a brief burst into failed logins.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
