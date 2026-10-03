import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
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
        'The AUTH_TOKEN configured on the server. Required on every endpoint ' +
        'except /health, unless the server runs with AUTH_DISABLED=true, ' +
        'which ignores the token.',
      type: 'http',
      scheme: 'bearer',
      // The token is an opaque shared secret, not the JWT Nest assumes.
      bearerFormat: undefined,
    })
    .addServer('/', 'Current environment')
    .build();

/**
 * Builds the OpenAPI document of an application: what the running server
 * serves at `/api-json` and what `npm run generate:openapi` commits.
 *
 * Operations of `@ApiBearerAuth()` controllers require the bearer token and
 * the rest (`/health`) declare no requirement, which is what the server
 * enforces by default. `AUTH_DISABLED=true` is a deployment opt-out the
 * scheme description mentions; the contract does not advertise anonymous
 * access as an alternative.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, createOpenApiConfig());
}
