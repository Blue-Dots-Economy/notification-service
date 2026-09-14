import { ProviderDefinition } from '../../../types/provider';
import { smsProvider as msg91Provider } from './msg91';
import { pinnacleSmsProvider } from './pinnacle';

/**
 * Which SMS vendor this deployment sends through, chosen by `SMS_PROVIDER`.
 *
 * One vendor per deployment is deliberately the *interim* model: routing a send
 * to a vendor per event or per priority is a real requirement (see the Pinnacle
 * design doc) but it needs a template catalogue NS does not own yet, so the
 * switch is deployment-wide until that lands.
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
    // Falling back silently would send through the wrong vendor — with the
    // wrong sender id and DLT entity — so this fails loudly at boot instead.
    throw new Error(
      `Unknown SMS_PROVIDER '${name}'. Expected one of: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return provider;
}

export const smsProvider: ProviderDefinition = selectSmsProvider();
