/**
 * The network this deployment serves. Deployment configuration, never request
 * input: it is the tenancy boundary for every template, policy and audit row.
 */
export class NetworkNotConfigured extends Error {
  constructor() {
    super('NS_NETWORK is not configured');
    this.name = 'NetworkNotConfigured';
  }
}

export function currentNetwork(env: NodeJS.ProcessEnv = process.env): string {
  const network = env.NS_NETWORK?.trim();
  if (!network) throw new NetworkNotConfigured();
  return network;
}

/** Locale used when a send names none and as the last fallback. */
export function defaultLocale(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_DEFAULT_LOCALE?.trim() || 'en';
}
