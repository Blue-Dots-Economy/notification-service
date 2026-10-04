import { providers } from '../providers';
import { serializeProvider } from './provider-docs';

const adminSecurity = [{ requestSignature: [], adminKey: [] }];

const errorBody = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          message: { type: 'string', description: 'Names variables, never their values.' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
});

const adminErrors = {
  '400': errorBody('Invalid request: unknown keys, wrong types or a malformed id'),
  '401': { description: 'Missing or invalid request signature' },
  '403': errorBody('The key id is not listed in NS_ADMIN_KEY_IDS ({"error":"admin scope required"})'),
  '404': errorBody('not_found: no such template or policy'),
  '409': errorBody('invalid_state: the row is not in a state that allows this change'),
  '422': errorBody(
    'A template or policy rule was violated (vendor_mismatch, incomplete_template, undeclared_token, unused_variable, body_too_long, invalid_contract, unknown_channel, missing_variable, unknown_variable, invalid_variable)'
  ),
  '503': errorBody('network_not_configured: NS_NETWORK is not set'),
};

const jsonBody = (schema: unknown) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const ok = (description: string, ref: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const statusEnum = ['draft', 'active', 'retired'];

const adminOp = (summary: string, description: string, extra: Record<string, unknown>) => ({
  summary,
  tags: ['admin'],
  description,
  security: adminSecurity,
  ...extra,
});

const templatePatchProperties = {
  subject: { type: ['string', 'null'], maxLength: 998 },
  body_html: { type: ['string', 'null'], maxLength: 200000 },
  body_text: { type: ['string', 'null'], maxLength: 10000 },
  variables: { type: 'array', maxItems: 50, items: { $ref: '#/components/schemas/VariableSpec' } },
  provider_template_id: { type: ['string', 'null'], maxLength: 255 },
  sender_id: { type: ['string', 'null'], maxLength: 64 },
  dlt_entity_id: { type: ['string', 'null'], maxLength: 64 },
  dlt_header_id: { type: ['string', 'null'], maxLength: 64 },
  dlt_tag_id: { type: ['string', 'null'], maxLength: 64 },
  approval_ref: { type: ['string', 'null'], maxLength: 255 },
  default_deadline_s: { type: ['integer', 'null'], minimum: 1, maximum: 86400 },
};

const policyChannels = {
  type: 'array',
  maxItems: 10,
  items: { $ref: '#/components/schemas/PolicyChannel' },
};

const adminSchemas = {
  VariableSpec: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', pattern: '^\\w+$', maxLength: 64, description: 'Names on Object.prototype are rejected.' },
      required: { type: 'boolean', default: true },
      type: { type: 'string', enum: ['string', 'number', 'url'], default: 'string' },
      sensitive: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false, description: 'Skip HTML escaping. Email only.' },
      urlHosts: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'Allowed hosts for url variables; subdomains match. Valid only when type is url.',
      },
    },
  },
  PolicyChannel: {
    type: 'object',
    required: ['channel', 'template_key'],
    additionalProperties: false,
    properties: {
      channel: { type: 'string', minLength: 1, maxLength: 32 },
      template_key: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 128 },
    },
  },
  Template: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      network: { type: 'string' },
      channel: { type: 'string' },
      template_key: { type: 'string' },
      locale: { type: 'string' },
      version: { type: 'integer' },
      status: { type: 'string', enum: statusEnum },
      subject: { type: ['string', 'null'] },
      body_html: { type: ['string', 'null'] },
      body_text: { type: ['string', 'null'] },
      variables: { type: 'array', items: { $ref: '#/components/schemas/VariableSpec' } },
      provider: { type: 'string', description: 'The vendor the template is registered for.' },
      provider_template_id: { type: ['string', 'null'] },
      sender_id: { type: ['string', 'null'] },
      dlt_entity_id: { type: ['string', 'null'] },
      dlt_header_id: { type: ['string', 'null'] },
      dlt_tag_id: { type: ['string', 'null'] },
      approval_ref: { type: ['string', 'null'] },
      default_deadline_s: { type: ['integer', 'null'] },
      created_by: { type: 'string' },
      published_by: { type: ['string', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      published_at: { type: ['string', 'null'], format: 'date-time' },
      retired_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  TemplateCreate: {
    type: 'object',
    required: ['channel', 'template_key'],
    additionalProperties: false,
    properties: {
      channel: { type: 'string', minLength: 1, maxLength: 32, example: 'sms' },
      template_key: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 128, example: 'welcome' },
      locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$', description: 'Defaults to NS_DEFAULT_LOCALE.' },
      ...templatePatchProperties,
    },
  },
  TemplatePatch: { type: 'object', additionalProperties: false, properties: templatePatchProperties },
  Policy: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      network: { type: 'string' },
      domain: { type: ['string', 'null'], description: 'null means any domain.' },
      event_type: { type: ['string', 'null'], description: 'null means any event.' },
      version: { type: 'integer' },
      status: { type: 'string', enum: statusEnum },
      mode: { type: 'string', enum: ['first_available', 'all'] },
      channels: policyChannels,
      created_by: { type: 'string' },
      published_by: { type: ['string', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      published_at: { type: ['string', 'null'], format: 'date-time' },
      retired_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  PolicyCreate: {
    type: 'object',
    required: ['mode', 'channels'],
    additionalProperties: false,
    properties: {
      domain: { type: ['string', 'null'], pattern: '^[a-z0-9_.-]+$', maxLength: 64 },
      event_type: { type: ['string', 'null'], pattern: '^[a-z0-9_.-]+$', maxLength: 64 },
      mode: { type: 'string', enum: ['first_available', 'all'] },
      channels: policyChannels,
    },
  },
  PolicyPatch: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['first_available', 'all'] },
      channels: policyChannels,
    },
  },
};

const templateListQuery = [
  { name: 'channel', in: 'query', schema: { type: 'string' } },
  { name: 'template_key', in: 'query', schema: { type: 'string' } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: statusEnum } },
];

const policyListQuery = [
  { name: 'domain', in: 'query', schema: { type: 'string' } },
  { name: 'event_type', in: 'query', schema: { type: 'string' } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: statusEnum } },
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const adminPaths = {
  '/v1/admin/templates': {
    get: adminOp('List templates', 'Filter by channel, template_key and status. Scoped to NS_NETWORK.', {
      parameters: templateListQuery,
      responses: {
        '200': {
          description: 'Templates',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { templates: { type: 'array', items: ref('Template') } } },
            },
          },
        },
        ...adminErrors,
      },
    }),
    post: adminOp('Create a template draft', 'Creates the next version as a draft. Only drafts are editable.', {
      requestBody: jsonBody(ref('TemplateCreate')),
      responses: { '201': ok('Draft created', 'Template'), ...adminErrors },
    }),
  },
  '/v1/admin/templates/{id}': {
    get: adminOp('Get a template', 'Any status.', {
      parameters: [idParam],
      responses: { '200': ok('Template', 'Template'), ...adminErrors },
    }),
    patch: adminOp('Edit a template draft', 'Active and retired templates are immutable (409 invalid_state); create a new draft instead.', {
      parameters: [idParam],
      requestBody: jsonBody(ref('TemplatePatch')),
      responses: { '200': ok('Updated draft', 'Template'), ...adminErrors },
    }),
  },
  '/v1/admin/templates/{id}/publish': {
    post: adminOp(
      'Publish a template draft',
      'Validates the template, then makes it active and retires the previous active version for the same (network, channel, template_key, locale) under an advisory lock.',
      {
        parameters: [idParam],
        responses: { '200': ok('Active template', 'Template'), ...adminErrors },
      }
    ),
  },
  '/v1/admin/templates/{id}/retire': {
    post: adminOp('Retire a template', 'Retiring never deletes the row.', {
      parameters: [idParam],
      responses: { '200': ok('Retired template', 'Template'), ...adminErrors },
    }),
  },
  '/v1/admin/templates/{id}/preview': {
    post: adminOp('Render a template with variables', 'Works for any status. Variables are validated against the contract; nothing is sent.', {
      parameters: [idParam],
      requestBody: jsonBody({
        type: 'object',
        additionalProperties: false,
        properties: { variables: { type: 'object', additionalProperties: true, default: {} } },
      }),
      responses: {
        '200': {
          description:
            'The render: mode ns returns the final subject/html/text (email) or text and messageType (SMS); mode provider returns providerTemplateId and the validated variables.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { rendered: { type: 'object', additionalProperties: true } } },
            },
          },
        },
        ...adminErrors,
      },
    }),
  },
  '/v1/admin/policies': {
    get: adminOp('List routing policies', 'Filter by domain, event_type and status. Scoped to NS_NETWORK.', {
      parameters: policyListQuery,
      responses: {
        '200': {
          description: 'Policies',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { policies: { type: 'array', items: ref('Policy') } } },
            },
          },
        },
        ...adminErrors,
      },
    }),
    post: adminOp('Create a policy draft', 'A null domain or event_type means "any".', {
      requestBody: jsonBody(ref('PolicyCreate')),
      responses: { '201': ok('Draft created', 'Policy'), ...adminErrors },
    }),
  },
  '/v1/admin/policies/{id}': {
    get: adminOp('Get a policy', 'Any status.', {
      parameters: [idParam],
      responses: { '200': ok('Policy', 'Policy'), ...adminErrors },
    }),
    patch: adminOp('Edit a policy draft', 'Active and retired policies are immutable (409 invalid_state).', {
      parameters: [idParam],
      requestBody: jsonBody(ref('PolicyPatch')),
      responses: { '200': ok('Updated draft', 'Policy'), ...adminErrors },
    }),
  },
  '/v1/admin/policies/{id}/publish': {
    post: adminOp(
      'Publish a policy draft',
      'Requires an active template for every listed channel. Retires the previous active policy for the same (domain, event_type) under an advisory lock.',
      {
        parameters: [idParam],
        responses: { '200': ok('Active policy', 'Policy'), ...adminErrors },
      }
    ),
  },
  '/v1/admin/policies/{id}/retire': {
    post: adminOp('Retire a policy', 'Retiring never deletes the row.', {
      parameters: [idParam],
      responses: { '200': ok('Retired policy', 'Policy'), ...adminErrors },
    }),
  },
};

export function openApiDocument() {
  const providerExamples = Object.fromEntries(
    Object.values(providers).map((provider) => [
      provider.name,
      {
        summary: `${provider.name} provider metadata`,
        value: serializeProvider(provider),
      },
    ])
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'Notification Service API',
      version: '1.0.0',
      description:
        'Provider-agnostic notification API with Redis-backed priority queues, retries, dedupe, and provider metadata.',
    },
    paths: {
      ...adminPaths,
      '/notify': {
        post: {
          summary: 'Queue a notification',
          security: [{ requestSignature: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['channel', 'to', 'template_id', 'variables'],
                  properties: {
                    channel: { type: 'string', example: 'email' },
                    to: { type: 'string', example: 'user@example.com' },
                    template_id: { type: 'string', example: 'basic_email' },
                    priority: {
                      type: 'string',
                      enum: ['realtime', 'other'],
                      default: 'other',
                    },
                    variables: { type: 'object', additionalProperties: true },
                    dedupe_id: { type: 'string' },
                  },
                },
                examples: {
                  email: {
                    value: {
                      channel: 'email',
                      template_id: 'basic_email',
                      to: 'user@example.com',
                      priority: 'realtime',
                      variables: {
                        fromName: 'Notification Service',
                        fromEmail: 'no-reply@example.com',
                        subject: 'Welcome',
                        html: '<h1>Hello</h1>',
                        replyTo: 'support@example.com',
                      },
                    },
                  },
                  sms: {
                    value: {
                      channel: 'sms',
                      template_id: 'login_otp',
                      to: '+918888888888',
                      variables: {
                        message: 'Your OTP is 987654',
                      },
                    },
                  },
                  whatsapp: {
                    value: {
                      channel: 'whatsapp',
                      template_id: 'dialflow',
                      to: '+918888888888',
                      variables: {
                        contentSid: null,
                        contentVariables: {},
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'Job accepted, or suppressed as a duplicate of a send the caller asked to dedupe via `dedupe_id`. Inspect `enqueued`: false means nothing was sent.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      job_id: { type: 'string' },
                      enqueued: { type: 'boolean' },
                      reason: { type: 'string', enum: ['duplicate'] },
                    },
                  },
                },
              },
            },
            '400': { description: 'Invalid request or provider/template' },
            '401': { description: 'Missing or invalid request signature' },
            '409': {
              description:
                'Suppressed as a duplicate by the fallback content-hash key (no `dedupe_id` was supplied). Nothing was sent. Pass an explicit `dedupe_id` if the send is a deliberate retry.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      job_id: { type: 'string' },
                      enqueued: { type: 'boolean' },
                      reason: { type: 'string', enum: ['duplicate-fallback'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/providers': {
        get: {
          summary: 'List providers and complete notify payloads',
          security: [{ requestSignature: [] }],
          responses: {
            '200': {
              description: 'Provider metadata',
              content: {
                'application/json': {
                  examples: providerExamples,
                },
              },
            },
          },
        },
      },
      '/providers/{name}': {
        get: {
          summary: 'Find a provider by name',
          security: [{ requestSignature: [] }],
          parameters: [
            {
              name: 'name',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              example: 'email',
            },
          ],
          responses: {
            '200': {
              description: 'Provider metadata',
              content: {
                'application/json': {
                  examples: providerExamples,
                },
              },
            },
            '404': { description: 'Provider not found' },
          },
        },
      },
      '/metrics/queue': {
        get: {
          summary: 'Read Redis queue metrics',
          security: [{ requestSignature: [] }],
          responses: {
            '200': {
              description: 'Queue depths and retry timing',
              content: {
                'application/json': {
                  example: {
                    status: 'ok',
                    timestamp: 1765363200000,
                    queues: {
                      realtime: 0,
                      other: 0,
                      retry_count: 0,
                      retry_oldest: null,
                      retry_eta_seconds: null,
                      dlq: 0,
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI document used by Scalar',
          security: [{ requestSignature: [] }],
          responses: {
            '200': { description: 'OpenAPI 3.1 document' },
          },
        },
      },
      '/failed/retry': {
        post: {
          summary: 'Manually retry failed jobs from the dead-letter queue',
          security: [{ requestSignature: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    job_id: {
                      type: 'string',
                      description:
                        'Retry a specific failed job. If omitted, retries up to limit jobs.',
                    },
                    limit: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 100,
                      default: 1,
                    },
                    priority: {
                      type: 'string',
                      enum: ['realtime', 'other'],
                      default: 'other',
                    },
                  },
                },
                examples: {
                  single: {
                    value: {
                      job_id: 'uuid',
                      priority: 'other',
                    },
                  },
                  batch: {
                    value: {
                      limit: 10,
                      priority: 'realtime',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Failed jobs requeued',
              content: {
                'application/json': {
                  example: {
                    retried: ['uuid'],
                    retried_count: 1,
                    skipped: 0,
                    not_found: [],
                  },
                },
              },
            },
            '400': { description: 'Invalid retry request' },
            '401': { description: 'Missing or invalid request signature' },
            '404': { description: 'Requested failed job was not found' },
          },
        },
      },
    },
    components: {
      schemas: adminSchemas,
      securitySchemes: {
        requestSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-NS-Signature',
          description:
            'Signed requests also require X-NS-Key, X-NS-Timestamp, and X-NS-Nonce.',
        },
        adminKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-NS-Key',
          description:
            'Admin routes also require the signing key id to be listed in NS_ADMIN_KEY_IDS (comma-separated); otherwise 403.',
        },
      },
    },
  };
}
