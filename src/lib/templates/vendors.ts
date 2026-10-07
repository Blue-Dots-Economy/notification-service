import { providers } from '../providers';

/** The deployment's vendor and render mode for a channel, or undefined if the channel is unknown. */
export function channelVendor(
  channel: string,
): { vendor: string; renders: 'ns' | 'provider' } | undefined {
  const p = providers[channel];
  return p ? { vendor: p.vendor, renders: p.renders } : undefined;
}
