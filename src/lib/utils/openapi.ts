import { providers } from '../providers';
import { CONTENT_KEY } from '../templates/contract';
import { serializeProvider } from './provider-docs';

// Either credential type authenticates a request (alternatives, not both at once).
// Role names inside `bearerAuth` are valid because the document is OpenAPI 3.1.
const sendSecurity = [{ requestSignature: [] }, { bearerAuth: ['notify:send'] }];
const adminSecurity = [{ requestSignature: [] }, { bearerAuth: ['templates:admin'] }];
const anySecurity = [{ requestSignature: [] }, { bearerAuth: [] }];


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

const unauthorized = () =>
  errorBody('Missing, malformed, expired or invalid credentials, or both credential types on one request');
const AUTH_UNAVAILABLE = 'auth unavailable: the Keycloak key set could not be reached for a bearer token';
const authUnavailable = () =>
  errorBody('Auth service unavailable: the Keycloak key set could not be reached for a bearer token');
const forbidden = (role: string) =>
  errorBody(`Insufficient scope: the credential lacks \`${role}\` ({"error":"Insufficient scope","required":"${role}"})`);

const adminErrors = {
  '400': {
    description: 'Validation error (Zod format): unknown keys, wrong types or a malformed id',
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
  },
  '401': unauthorized(),
  '403': forbidden('templates:admin'),
  '404': errorBody('not_found: no such template or policy'),
  '409': errorBody('invalid_state: the row is not in a state that allows this change'),
  '422': errorBody(
    'A template or policy rule was violated (vendor_mismatch, incomplete_template, undeclared_token, unused_variable, body_too_long, invalid_contract, unknown_channel, missing_variable, unknown_variable, invalid_variable, content_unavailable, unknown_content_key, content_unresolved, invalid_content)'
  ),
  '503': errorBody(
    `network_not_configured: NS_NETWORK is not set; database_unavailable: the template/policy store could not be reached; ${AUTH_UNAVAILABLE}`,
  ),
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
  Catalogue: {
    type: 'object',
    required: ['version', 'templates', 'policies'],
    additionalProperties: false,
    properties: {
      version: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
      templates: {
        type: 'array',
        maxItems: 500,
        items: { $ref: '#/components/schemas/TemplateEntry' },
      },
      policies: { type: 'array', maxItems: 500, items: { $ref: '#/components/schemas/PolicyCreate' } },
    },
  },
  SendAccepted: {
    type: 'object',
    required: ['notification_event_id', 'correlation_id', 'status', 'mode', 'deliveries'],
    properties: {
      notification_event_id: { type: 'string', format: 'uuid' },
      correlation_id: { type: 'string' },
      status: { type: 'string', enum: ['accepted'] },
      mode: { type: 'string', enum: ['single', 'first_available', 'all'] },
      deliveries: {
        type: 'array',
        items: { type: 'object', required: ['channel'], properties: { channel: { type: 'string' } } },
      },
    },
  },
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
      source: {
        type: 'string',
        enum: ['request', 'content_ref'],
        default: 'request',
        description:
          'request: the caller supplies the value. content_ref: the value comes from the shared content file by `contentKey`; callers cannot supply it. content_ref variables are always required and cannot be sensitive.',
      },
      contentKey: {
        type: 'string',
        maxLength: 128,
        pattern: CONTENT_KEY.source,
        description: 'The content key, e.g. tnc.in_force.url. Required when source is content_ref, and valid only then.',
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
  TemplateEntry: {
    type: 'object',
    description: 'A catalogue template: the template create body plus `provider`. Only email entries may omit `provider`; SMS and WhatsApp entries name the vendor they are for.',
    required: ['channel', 'template_key'],
    additionalProperties: false,
    properties: {
      channel: { type: 'string', minLength: 1, maxLength: 32, example: 'sms' },
      template_key: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 128, example: 'welcome' },
      locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$', description: 'Defaults to NS_DEFAULT_LOCALE.' },
      provider: { type: 'string', minLength: 1, maxLength: 32, example: 'msg91', description: 'Required unless channel is email.' },
      ...templatePatchProperties,
    },
  },
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

const adminExportPath = {
  '/v1/admin/export': {
    get: adminOp(
      'Export the active catalogue',
      'Active templates (for the deployment\'s current vendors) and policies of NS_NETWORK, in the catalogue format that NS_SEED_FILE reads. Carries no ids, versions, actors or timestamps; output is sorted so two exports of one store are identical apart from `version` (the export timestamp).',
      {
        responses: {
          '200': {
            description: 'Catalogue',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Catalogue' } } },
          },
          '401': adminErrors['401'],
          '403': adminErrors['403'],
          '422': errorBody('export_invalid: the active rows do not fit the catalogue format (e.g. more than 500 templates); the message names paths only'),
          '503': adminErrors['503'],
        },
      }
    ),
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
      ...adminExportPath,
      '/v1/notify': {
        post: {
          summary: 'Send a notification (Send API v1)',
          tags: ['send'],
          description:
            'Send by `event_type` (a policy picks the channels) or by `template_key` + `channel`. Content is rendered and validated before the request is accepted. `network` is server config and is never read from the request.',
          security: sendSecurity,
          requestBody: jsonBody({
            type: 'object',
            additionalProperties: false,
            required: ['to'],
            description: 'Exactly one of `event_type` or `template_key`. `template_key` requires `channel`; `event_type` forbids it.',
            properties: {
              event_type: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 64, example: 'login_otp' },
              template_key: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 128 },
              channel: { type: 'string', minLength: 1, maxLength: 32, example: 'sms' },
              domain: { type: 'string', pattern: '^[a-z0-9_.-]+$', maxLength: 64 },
              to: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  email: { type: 'string', format: 'email', maxLength: 254 },
                  phone: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$', description: 'E.164' },
                },
              },
              locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
              variables: {
                type: 'object',
                additionalProperties: true,
                default: {},
                description:
                  'With `event_type`, variables are data: each planned template takes the ones it declares and the rest are ignored; a required one that is missing is `missing_variable`. With `template_key`, a name the template does not declare is `422 unknown_variable`.',
              },
              priority: { type: 'string', enum: ['urgent', 'normal', 'bulk'], default: 'normal' },
              idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
              deadline: {
                type: 'string',
                format: 'date-time',
                description: 'ISO-8601 with offset; must be in the future and at most 24 hours ahead.',
              },
              cc: { type: 'array', maxItems: 10, items: { type: 'string', format: 'email' }, description: 'Email deliveries only.' },
              reply_to: { type: 'string', format: 'email', description: 'Email deliveries only.' },
              attachments: {
                type: 'array',
                description: 'Email deliveries only. Count and total size limits as on `/notify`.',
                items: {
                  type: 'object',
                  required: ['filename', 'contentType', 'data'],
                  properties: {
                    filename: { type: 'string', minLength: 1, maxLength: 255 },
                    contentType: { type: 'string', minLength: 1, maxLength: 127, example: 'application/pdf' },
                    data: { type: 'string', format: 'byte', description: 'Base64 file content, no `data:` prefix.' },
                  },
                },
              },
              correlation_id: {
                type: 'string',
                maxLength: 128,
                description: 'Trimmed. Wins over the `x-correlation-id` header; blank falls back to the header, then the event id.',
              },
            },
          }),
          responses: {
            '200': {
              description: 'A repeat of an `idempotency_key`: the original 202 response.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SendAccepted' } } },
            },
            '202': {
              description: 'Accepted. Delivery is asynchronous.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SendAccepted' } } },
            },
            '400': { description: 'Invalid request (Zod format), or `invalid_deadline`' },
            '401': unauthorized(),
            '403': forbidden('notify:send'),
            '409': errorBody('idempotency_in_progress, or duplicate-fallback (a repeat without an idempotency_key within 5 seconds)'),
            '422': {
              description:
                'The send was refused. `kind` is `caller` (missing_variable, unknown_variable, invalid_variable, no_reachable_channel) or `configuration` (not_found, vendor_mismatch, incomplete_template, body_too_long, unknown_channel, no_policy, content_unavailable, unknown_content_key, content_unresolved, invalid_content).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error', 'kind', 'message'],
                    properties: {
                      error: { type: 'string' },
                      kind: { type: 'string', enum: ['caller', 'configuration'] },
                      message: { type: 'string', description: 'Names variables, never their values.' },
                      details: { type: 'object', additionalProperties: true },
                    },
                  },
                },
              },
            },
            '503': errorBody(
              `network_not_configured: NS_NETWORK is not set; template store unavailable: a template or policy not yet cached could not be read; audit store unavailable (normal and bulk sends); ${AUTH_UNAVAILABLE}`,
            ),
          },
        },
      },
      '/notify': {
        post: {
          summary: 'Queue a notification',
          description:
            'Legacy send route, kept until the cutover release. Requires `notify:send`. Also accepts HMAC `v1` signatures (no body digest).',
          security: sendSecurity,
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
            '401': unauthorized(),
            '403': forbidden('notify:send'),
            '503': authUnavailable(),
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
          security: anySecurity,
          responses: {
            '401': unauthorized(),
            '503': authUnavailable(),
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
          security: anySecurity,
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
            '401': unauthorized(),
            '404': { description: 'Provider not found' },
            '503': authUnavailable(),
          },
        },
      },
      '/metrics/queue': {
        get: {
          summary: 'Read Redis queue metrics',
          security: anySecurity,
          responses: {
            '401': unauthorized(),
            '503': authUnavailable(),
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
          summary: 'OpenAPI document used by Scalar (served only when NS_DOCS_ENABLED=true)',
          responses: {
            '200': { description: 'OpenAPI 3.1 document' },
          },
        },
      },
      '/failed/retry': {
        post: {
          summary: 'Manually retry failed jobs from the dead-letter queue',
          description: 'Operator action: requires `templates:admin`. A credential holding only `notify:send` receives 403.',
          security: adminSecurity,
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
            '401': unauthorized(),
            '403': forbidden('templates:admin'),
            '404': { description: 'Requested failed job was not found' },
            '503': authUnavailable(),
          },
        },
      },
    },
    components: {
      schemas: adminSchemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Keycloak access token. Requires `aud` = the configured audience (default `notification-service`) and an allowlisted `azp`. Roles come from the `notification-service` client roles: `notify:send` and `templates:admin`. Do not send alongside the HMAC headers.',
        },
        requestSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-NS-Signature',
          description:
            'HMAC v2. Send X-NS-Key (key id), X-NS-Timestamp (unix seconds, within 30 s of server time), X-NS-Nonce (unique per request) and X-NS-Signature: v2=<64 lowercase hex>. The signature is HMAC-SHA256 with the key secret over the canonical string METHOD\\npath\\ntimestamp\\nnonce\\nsha256(body), where path includes the query string and the digest is lowercase hex SHA-256 over the exact body bytes (the empty string when there is no body). v1 (METHOD\\npath\\ntimestamp\\nnonce) is accepted only on legacy /notify until the cutover release. Scopes come from the key\'s `scopes` entry in internal-secrets.json (default `notify:send`). Do not send alongside an Authorization header.',
        },
      },
    },
  };
}
