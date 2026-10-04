const CALLER = new Set(['missing_variable', 'unknown_variable', 'invalid_variable', 'no_reachable_channel']);

export function classify(code: string): 'caller' | 'configuration' {
  return CALLER.has(code) ? 'caller' : 'configuration';
}

/** Why a send was refused. Messages name variables and keys, never values. */
export class SendError extends Error {
  readonly kind: 'caller' | 'configuration';
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'SendError';
    this.kind = classify(code);
  }
}
