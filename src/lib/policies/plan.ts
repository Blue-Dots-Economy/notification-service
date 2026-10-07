import type { PolicyChannel, PolicyMode, PolicyRow } from '../db/schema';

export interface Contacts {
  email?: string;
  phone?: string;
}

/** Which contact point each channel needs. NS holds no user directory: callers pass what they have. */
export const CHANNEL_CONTACT: Record<string, keyof Contacts> = {
  email: 'email',
  sms: 'phone',
  whatsapp: 'phone',
};

/**
 * The channels a send may use, in policy order, filtered to the contact points
 * the caller supplied. `first_available` tries them in order; `all` fans out.
 */
export function planDelivery(
  policy: Pick<PolicyRow, 'mode' | 'channels'>,
  contacts: Contacts,
): { mode: PolicyMode; candidates: PolicyChannel[] } {
  const candidates = policy.channels.filter((c) => {
    const need = CHANNEL_CONTACT[c.channel];
    return need !== undefined && Boolean(contacts[need]?.trim());
  });
  return { mode: policy.mode, candidates };
}
