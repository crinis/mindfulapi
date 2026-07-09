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
 * @param document The document produced by SwaggerModule.createDocument.
 */
export function patchOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.security = [{ bearer: [] }, {}];
  return document;
}
