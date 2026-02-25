import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Shared OpenAPI document configuration used by both the running server
 * (`main.ts`) and the spec generation script (`scripts/generate-openapi.ts`).
 */
export const createOpenApiConfig = () =>
  new DocumentBuilder()
    .setTitle('MindfulAPI')
    .setDescription(
      'Automated web accessibility scanning API powered by axe-core and Playwright. ' +
        'Built for use with the [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension.',
    )
    .setVersion('1.0')
    .addTag('Scans', 'Create and inspect accessibility scan runs')
    .addTag('Rules', 'List available axe-core rules and metadata')
    .addTag('Cleanup', 'Manage retention cleanup lifecycle')
    .addBearerAuth({
      description:
        'Set the AUTH_TOKEN environment variable to enable authentication. Leave unset for open access.',
      type: 'http',
      scheme: 'bearer',
    })
    .addServer('/', 'Current environment')
    .build();
