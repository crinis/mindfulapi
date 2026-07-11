import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: packageVersion } = require('../../package.json') as {
  version: string;
};

/**
 * Shared OpenAPI document configuration used by both the running server
 * (`main.ts`) and the spec generation script (`scripts/generate-openapi.ts`).
 */
export const createOpenApiConfig = () =>
  new DocumentBuilder()
    .setTitle('MindfulAPI')
    .setDescription(
      'Automated web accessibility scanning API powered by axe-core and Playwright. ' +
        'Built for use with the [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension. ' +
        'Errors are returned as RFC 9457 `application/problem+json`.',
    )
    .setVersion(packageVersion)
    .addTag('Scans', 'Create and inspect accessibility scan runs')
    .addTag('Reports', 'Generate HTML and PDF accessibility reports')
    .addTag('Rules', 'List available axe-core rules and metadata')
    .addTag('Cleanup', 'Manage retention cleanup lifecycle')
    .addTag('Health', 'Liveness and readiness probes')
    .addBearerAuth({
      description:
        'Set the AUTH_TOKEN environment variable to enable authentication. ' +
        'When authentication is disabled (AUTH_DISABLED=true), the token is ignored.',
      type: 'http',
      scheme: 'bearer',
    })
    .addServer('/', 'Current environment')
    .build();

/**
 * Post-processes the generated document to express that authentication is
 * optional: the empty security requirement `{}` is the only OpenAPI-legal way
 * to say "no auth is also accepted" alongside the bearer scheme.
 *
 * Each `@ApiBearerAuth()` controller also emits an operation-level
 * `security: [{ bearer: [] }]`, which fully overrides the document default —
 * so the empty requirement has to be appended to every such operation too,
 * otherwise the spec still mandates auth on every non-health endpoint even in
 * `AUTH_DISABLED=true` mode.
 *
 * @param document The document produced by SwaggerModule.createDocument.
 */
export function patchOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.security = [{ bearer: [] }, {}];

  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      const security = (operation as { security?: unknown })?.security;
      if (!Array.isArray(security)) {
        continue;
      }
      const allowsNoAuth = security.some(
        (requirement) => Object.keys(requirement as object).length === 0,
      );
      if (!allowsNoAuth) {
        security.push({});
      }
    }
  }

  return document;
}
