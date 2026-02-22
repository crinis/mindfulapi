import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { ScanMode } from '../../../enums/scan-mode.enum';
import { CrawlOptionsDto } from './crawl-options.dto';
import { ScanOptionsDto } from './scan-options.dto';

/**
 * OpenAPI schema variant for creating a single URL scan run.
 */
export class CreateSingleUrlScanDto {
  /** Discriminator value identifying the single URL payload variant. */
  @ApiProperty({ enum: [ScanMode.SINGLE_URL], example: ScanMode.SINGLE_URL })
  mode: ScanMode.SINGLE_URL;

  /** Absolute URL of the page that should be analyzed. */
  @ApiProperty({
    example: 'https://example.com',
    format: 'uri',
    description: 'Single page URL to analyze.',
  })
  url: string;

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  scanOptions?: ScanOptionsDto;
}

/**
 * OpenAPI schema variant for creating an explicit URL list scan run.
 */
export class CreateUrlListScanDto {
  /** Discriminator value identifying the URL list payload variant. */
  @ApiProperty({ enum: [ScanMode.URL_LIST], example: ScanMode.URL_LIST })
  mode: ScanMode.URL_LIST;

  /** Fixed set of URLs that will be analyzed without link discovery. */
  @ApiProperty({
    example: ['https://example.com', 'https://example.com/about'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
    uniqueItems: true,
    minItems: 2,
    description: 'Explicit list of page URLs to analyze.',
  })
  urls: string[];

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  scanOptions?: ScanOptionsDto;
}

/**
 * OpenAPI schema variant for creating a crawl-based scan run.
 */
export class CreateCrawlScanDto {
  /** Discriminator value identifying the crawl payload variant. */
  @ApiProperty({ enum: [ScanMode.CRAWL], example: ScanMode.CRAWL })
  mode: ScanMode.CRAWL;

  /** One or more crawl seed URLs used as discovery entry points. */
  @ApiProperty({
    example: ['https://example.com'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
    uniqueItems: true,
    minItems: 1,
    description:
      'One or more seed URLs used as crawl entry points for page discovery.',
  })
  startUrls: string[];

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  scanOptions?: ScanOptionsDto;

  /** Optional crawl behavior settings specific to crawl mode. */
  @ApiPropertyOptional({ type: () => CrawlOptionsDto })
  crawlOptions?: CrawlOptionsDto;
}

/**
 * `oneOf` OpenAPI schema used for create-scan request bodies.
 */
export const createScanRequestOneOfSchema = {
  oneOf: [
    { $ref: getSchemaPath(CreateSingleUrlScanDto) },
    { $ref: getSchemaPath(CreateUrlListScanDto) },
    { $ref: getSchemaPath(CreateCrawlScanDto) },
  ],
  discriminator: {
    propertyName: 'mode',
    mapping: {
      [ScanMode.SINGLE_URL]: getSchemaPath(CreateSingleUrlScanDto),
      [ScanMode.URL_LIST]: getSchemaPath(CreateUrlListScanDto),
      [ScanMode.CRAWL]: getSchemaPath(CreateCrawlScanDto),
    },
  },
};

/**
 * OpenAPI-compatible example object shape.
 */
interface OpenApiExampleObject {
  /** Optional short example title shown in Swagger UI. */
  summary?: string;
  /** Optional longer explanation for the example. */
  description?: string;
  /** Example payload value. */
  value?: unknown;
  /** Optional URL pointing to an external example payload. */
  externalValue?: string;
}

/**
 * Named request examples used by Swagger UI for the create-scan endpoint.
 */
export const createScanRequestExamples: Record<string, OpenApiExampleObject> = {
  singleUrl: {
    summary: 'Single URL run',
    description: 'Analyze one page URL.',
    value: {
      mode: ScanMode.SINGLE_URL,
      url: 'https://example.com',
      scanOptions: {
        rootElement: 'main',
      },
    },
  },
  urlList: {
    summary: 'URL list run',
    description: 'Analyze a fixed list of URLs.',
    value: {
      mode: ScanMode.URL_LIST,
      urls: ['https://example.com', 'https://example.com/about'],
      scanOptions: {
        ruleIds: ['image-alt', 'color-contrast'],
      },
    },
  },
  crawl: {
    summary: 'Crawl run',
    description:
      'Discover and analyze pages by crawling from one or more seeds.',
    value: {
      mode: ScanMode.CRAWL,
      startUrls: ['https://example.com'],
      scanOptions: {
        rootElement: 'main',
      },
      crawlOptions: {
        maxPages: 250,
        maxDepth: 4,
        strategy: 'same-hostname',
        globs: ['https://example.com/docs/**'],
        excludeGlobs: ['**/private/**'],
      },
    },
  },
};
