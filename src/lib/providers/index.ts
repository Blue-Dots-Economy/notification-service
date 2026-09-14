import fs from 'fs';
import path from 'path';
import { ProviderDefinition } from '../../types/provider';

const providersDir = path.join(__dirname);

export const providers: Record<string, ProviderDefinition> = {};

/**
 * A module export is a provider if it has the shape of one. This used to take
 * `Object.keys(module)[0]`, which happened to work only while each provider
 * folder exported exactly one thing — the SMS folder now also exports
 * `selectSmsProvider`, and that only kept working because tsc happened to emit
 * the definition first. Turning that helper into a `const` would have reordered
 * the exports and made every SMS send 400 with "Unknown provider channel",
 * with nothing in the diff to suggest why.
 */
function isProviderDefinition(value: unknown): value is ProviderDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderDefinition>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.send === 'function' &&
    typeof candidate.templates === 'object' &&
    candidate.templates !== null
  );
}

for (const dir of fs.readdirSync(providersDir)) {
  const full = path.join(providersDir, dir);
  if (!fs.statSync(full).isDirectory()) continue;

  const providerModule = require(path.join(full, 'index.js'));
  const definitions = Object.values(providerModule).filter(isProviderDefinition);

  if (definitions.length === 0) {
    throw new Error(`Provider folder '${dir}' exports no ProviderDefinition`);
  }
  if (definitions.length > 1) {
    // Two definitions in one folder means one of them silently never registers.
    throw new Error(
      `Provider folder '${dir}' exports ${definitions.length} ProviderDefinitions; expected exactly one`
    );
  }

  providers[definitions[0]!.name] = definitions[0]!;
}
