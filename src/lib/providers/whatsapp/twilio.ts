import { z } from 'zod';
import { ProviderDefinition } from '../../../types/provider';
import { sendWhatsAppMessage } from './twilioSend';

export const whatsappProvider: ProviderDefinition = {
  name: 'whatsapp',

  templates: {
    dialflow: 'HXa9cc9766cfdd966ae28b7ebc4ca0d09e',
    other: 'other',
  },

  schema: z.object({
    contentSid: z.string().nullable().describe('set template_id to other'),
    contentVariables: z.record(z.string(), z.any()).nullable().optional(),
  }),

  async send({ to, template_id, variables }) {
    const contentSid =
      template_id === 'other' ? variables.contentSid : template_id;
    const contentVariables = variables.contentVariables ?? null;
    const ok = await sendWhatsAppMessage(to, contentSid, contentVariables);
    return ok;
  },
};
