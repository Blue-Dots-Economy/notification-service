import { ZodType } from 'zod';

export interface ProviderTemplateMap {
  [templateId: string]: string;
}

export interface ProviderDefinition {
  name: string;
  templates: ProviderTemplateMap;
  /**
   * When true, a `template_id` not found in `templates` is passed through to the
   * provider verbatim (treated as a raw provider-side template id). Lets the
   * caller own the id map — e.g. SMS, where signalstack sends the DLT-approved
   * MSG91 flow id directly (#532/#535). Default (undefined/false) keeps the
   * strict allowlist, so email must still name a known template.
   */
  allowRawTemplateId?: boolean;
  schema: ZodType<any>;
  send: (payload: {
    to: string;
    template_id: string;
    variables: any;
  }) => Promise<{ ok: boolean; error?: string }>;
}
