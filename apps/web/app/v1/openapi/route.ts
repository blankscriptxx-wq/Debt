import { NextResponse } from 'next/server';
import { PERMISSIONS, isRegulatedPermission } from '@solvenda/auth';

/**
 * The OpenAPI description, generated rather than maintained by hand so it
 * cannot drift from the permission catalogue it documents.
 *
 * The `x-regulated-permissions` block is deliberate: an integrator should be
 * able to see, from the specification alone, which actions no API key will ever
 * be able to perform, rather than discovering it when a request is refused.
 */
export function GET() {
  const regulated = PERMISSIONS.filter((p) => isRegulatedPermission(p.key));

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Solvenda API',
      version: '1.0.0',
      description:
        'The Solvenda platform API. Authenticate with an API key as ' +
        '`Authorization: Bearer sk_...`. Keys carry permission scopes; regulated actions ' +
        'require an authenticated person and are therefore not available to any key.',
    },
    servers: [{ url: '/v1', description: 'Versioned base path' }],
    security: [{ apiKey: [] }],
    'x-regulated-permissions': {
      description:
        'These permissions can only be exercised by an authenticated person holding the ' +
        'relevant competency. An API key cannot hold them - the platform refuses them at ' +
        'key creation as well as at use.',
      permissions: regulated.map((p) => ({ key: p.key, description: p.description })),
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'sk_live_... or sk_test_...' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requiredScope: { type: 'string' },
              },
            },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            hasMore: { type: 'boolean' },
            nextCursor: { type: ['string', 'null'] },
          },
        },
        Case: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string' },
            stage: { type: 'string' },
            status: { type: 'string',
                      enum: ['open', 'on-hold', 'closed', 'withdrawn', 'transferred'] },
            jurisdiction: { type: 'string',
                            enum: ['england-wales', 'scotland', 'northern-ireland'] },
            totalDebtPence: { type: 'integer',
                              description: 'Integer pence. Never a decimal.' },
          },
        },
        Client: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            jurisdiction: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/cases': {
        get: {
          summary: 'List cases',
          'x-required-scope': 'case:read',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 25 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'stage', in: 'query', schema: { type: 'string' } },
            { name: 'case_type', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'A page of cases' } },
        },
        post: {
          summary: 'Create a case for an existing client',
          'x-required-scope': 'case:write',
          description:
            'Advice, solutions and financial statements are not accepted here: they are ' +
            'regulated records that require a person.',
          responses: { '201': { description: 'Created' },
                       '422': { description: 'Unknown case type' } },
        },
      },
      '/cases/{id}': {
        get: {
          summary: 'Retrieve a case with its debts and current financial statement',
          'x-required-scope': 'case:read',
          parameters: [{ name: 'id', in: 'path', required: true,
                         schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'The case' }, '404': { description: 'Not found' } },
        },
      },
      '/clients': {
        get: { summary: 'List clients', 'x-required-scope': 'client:read',
               responses: { '200': { description: 'A page of clients' } } },
        post: {
          summary: 'Create a client, typically a referral',
          'x-required-scope': 'client:write',
          description:
            'Vulnerability information is not accepted: it is special category data ' +
            'requiring an Article 9 condition and an adviser assessment.',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/events': {
        get: {
          summary: 'Poll the event stream',
          'x-required-scope': 'case:read',
          description: 'The same events webhooks deliver, for integrators who cannot receive one.',
          parameters: [
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { '200': { description: 'A page of events' } },
        },
      },
    },
  };

  return NextResponse.json(spec, {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
