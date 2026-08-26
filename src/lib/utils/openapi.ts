import { providers } from '../providers';
import { serializeProvider } from './provider-docs';

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
      securitySchemes: {
        requestSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-NS-Signature',
          description:
            'Signed requests also require X-NS-Key, X-NS-Timestamp, and X-NS-Nonce.',
        },
      },
    },
  };
}
