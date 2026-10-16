import { isTimeoutError, providerTimeoutMs } from '../http';

type TwilioResponse = {
  sid: string;
  status: string;
  error_code: number | null;
  error_message: string | null;
};

/**
 * Sends a WhatsApp message via Twilio API.
 *
 * @param to - The recipient WhatsApp number.
 *   - Must start with `"whatsapp:"` followed by the E.164 formatted phone number.
 *   - Example: `"whatsapp:+919876543210"`.
 *
 * @param contentSid - contentSid for the template to be used.
 *
 * @throws Will throw an error if the Twilio API request fails or returns an error_code.
 *
 * @example
 * ```ts
 * await sendWhatsAppMessage("whatsapp:+15005550006", "HXXXXXXXXXXXXX");
 * ```
 */

export async function sendWhatsAppMessage(
  to: string,
  contentSid: string,
  variables?: Record<string, any>
): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID!;
  const from = process.env.TWILIO_WHATSAPP_NUMBER!; // Twilio sandbox number or your approved number

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.append('From', from);
  params.append('To', 'whatsapp:' + to);
  params.append('ContentSid', contentSid);
  params.append('MessagingServiceSid', messagingServiceSid);

  if (variables) {
    params.append('ContentVariables', JSON.stringify(variables));
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(providerTimeoutMs()),
    });
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, error: 'provider timeout', retryable: true };
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    console.log(`Twilio API call failed: ${response.status} - ${errText}`);
    return { ok: false, error: errText };
  }

  const data = (await response.json()) as TwilioResponse;

  if (data.error_code) {
    switch (data.error_code) {
      case 63016:
        console.error('Error 63016: Outside 24h window, need template.');
        break;
      case 63049:
        console.error('Error 63049: Marketing message blocked by Meta.');
        break;
      default:
        console.error(
          `Twilio returned error ${data.error_code}: ${data.error_message}`
        );
    }
    return { ok: false, error: data.error_code.toString() };
  } else {
    console.log(
      `Message queued successfully (SID: ${data.sid}, Status: ${data.status})`
    );
    return { ok: true };
  }
}
