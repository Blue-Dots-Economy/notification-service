import { ProviderDefinition } from '../../../types/provider';
import { smsProvider as msg91Provider } from './msg91';
import { pinnacleSmsProvider } from './pinnacle';

/**
 * Which SMS vendor this deployment sends through, chosen by `SMS_PROVIDER`.
 * There is one vendor per channel per deployment: templates are registered per
 * vendor (DLT ids), so another vendor's id would be meaningless. Known
 * limitation: a send cannot be routed to a vendor per event or priority.
 *
 * Both definitions declare `name: 'sms'`, so the channel key, the rate-limit
 * key and every caller are identical whichever is selected.
 */
const PROVIDERS: Record<string, ProviderDefinition> = {
  msg91: msg91Provider,
  pinnacle: pinnacleSmsProvider,
};

export function selectSmsProvider(env = process.env): ProviderDefinition {
  const name = (env.SMS_PROVIDER || 'msg91').trim().toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) {
    // No fallback: another vendor would send with the wrong sender id and DLT
    // entity, so boot fails instead.
    throw new Error(
      `Unknown SMS_PROVIDER '${name}'. Expected one of: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return provider;
}

export const smsProvider: ProviderDefinition = selectSmsProvider();
