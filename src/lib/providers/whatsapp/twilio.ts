import { ProviderDefinition } from '../../../types/provider';
import { sendWhatsAppMessage } from './twilioSend';

export const whatsappProvider: ProviderDefinition = {
  name: 'whatsapp',
  vendor: 'twilio',
  renders: 'provider',

  async sendRendered({ to, rendered, providerTemplateId }) {
    if (rendered.mode !== 'provider' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by twilio' };
    }
    return sendWhatsAppMessage(to, providerTemplateId, rendered.variables);
  },
};
