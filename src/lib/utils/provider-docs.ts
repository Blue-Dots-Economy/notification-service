import type { ProviderDefinition } from '../../types/provider';

/** What `GET /providers` publishes per channel: the vendor and who renders. */
export function serializeProvider(provider: ProviderDefinition): { name: string; vendor: string; renders: 'ns' | 'provider' } {
  return { name: provider.name, vendor: provider.vendor, renders: provider.renders };
}
