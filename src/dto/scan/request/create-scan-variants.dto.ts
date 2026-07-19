import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsObject,
  IsOptional,
  IsUrl,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ScanMode } from '../../../enums/scan-mode.enum';
import { HTTP_URL_VALIDATION_OPTIONS } from '../../../constants/url-validation.constants';
import { CrawlOptionsDto } from './crawl-options.dto';
import { ScanOptionsDto } from './scan-options.dto';
import { AiAuditRequestDto } from './ai-audit.dto';

/** Optional AI-audit opt-in field shared by every create-scan variant. */
const aiAuditApiProperty = {
  type: () => AiAuditRequestDto,
  description:
    'Optional AI audit. Availability depends on the server-configured allowed scan modes (single_url by default); requests for a disallowed mode return 400.',
} as const;

/** Upper bound on url_list targets per scan. */
const MAX_URL_LIST_ITEMS = 500;
/** Upper bound on crawl seed URLs per scan. */
const MAX_CRAWL_SEED_ITEMS = 50;

/**
 * Request variant for creating a single URL scan run. This class is both the
 * validated runtime type (via {@link DiscriminatedBodyPipe}) and the documented
 * OpenAPI schema, so the two cannot drift.
 */
export class CreateSingleUrlScanDto {
  /** Discriminator value identifying the single URL payload variant. */
  @ApiProperty({ enum: [ScanMode.SINGLE_URL], example: ScanMode.SINGLE_URL })
  @Equals(ScanMode.SINGLE_URL)
  mode: ScanMode.SINGLE_URL;

  /** Absolute URL of the page that should be analyzed. */
  @ApiProperty({
    example: 'https://example.com',
    format: 'uri',
    description: 'Single page URL to analyze.',
  })
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS)
  url: string;

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScanOptionsDto)
  scanOptions?: ScanOptionsDto;

  /** Optional opt-in to the LLM-agent audit for this run. */
  @ApiPropertyOptional(aiAuditApiProperty)
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AiAuditRequestDto)
  aiAudit?: AiAuditRequestDto;
}

/**
 * Request variant for creating an explicit URL list scan run.
 */
export class CreateUrlListScanDto {
  /** Discriminator value identifying the URL list payload variant. */
  @ApiProperty({ enum: [ScanMode.URL_LIST], example: ScanMode.URL_LIST })
  @Equals(ScanMode.URL_LIST)
  mode: ScanMode.URL_LIST;

  /** Fixed set of URLs that will be analyzed without link discovery. */
  @ApiProperty({
    example: ['https://example.com', 'https://example.com/about'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
    uniqueItems: true,
    minItems: 2,
    maxItems: MAX_URL_LIST_ITEMS,
    description: 'Explicit list of page URLs to analyze.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_URL_LIST_ITEMS)
  @ArrayUnique()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS, { each: true })
  urls: string[];

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScanOptionsDto)
  scanOptions?: ScanOptionsDto;

  /** Optional opt-in to the LLM-agent audit for this run. */
  @ApiPropertyOptional(aiAuditApiProperty)
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AiAuditRequestDto)
  aiAudit?: AiAuditRequestDto;
}

/**
 * Request variant for creating a crawl-based scan run.
 */
export class CreateCrawlScanDto {
  /** Discriminator value identifying the crawl payload variant. */
  @ApiProperty({ enum: [ScanMode.CRAWL], example: ScanMode.CRAWL })
  @Equals(ScanMode.CRAWL)
  mode: ScanMode.CRAWL;

  /** One or more crawl seed URLs used as discovery entry points. */
  @ApiProperty({
    example: ['https://example.com'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
    uniqueItems: true,
    minItems: 1,
    maxItems: MAX_CRAWL_SEED_ITEMS,
    description:
      'One or more seed URLs used as crawl entry points for page discovery.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CRAWL_SEED_ITEMS)
  @ArrayUnique()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS, { each: true })
  startUrls: string[];

  /** Optional scan behavior settings shared across all run modes. */
  @ApiPropertyOptional({ type: () => ScanOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScanOptionsDto)
  scanOptions?: ScanOptionsDto;

  /** Optional opt-in to the LLM-agent audit for this run. */
  @ApiPropertyOptional(aiAuditApiProperty)
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AiAuditRequestDto)
  aiAudit?: AiAuditRequestDto;

  /** Optional crawl behavior settings specific to crawl mode. */
  @ApiPropertyOptional({ type: () => CrawlOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlOptionsDto)
  crawlOptions?: CrawlOptionsDto;
}

/**
 * Discriminated union of the three create-scan request variants. This is the
 * type accepted by the create-scan endpoint after {@link DiscriminatedBodyPipe}
 * validation.
 */
export type CreateScanRequest =
  | CreateSingleUrlScanDto
  | CreateUrlListScanDto
  | CreateCrawlScanDto;

/** Maps each mode discriminator to its validated request class. */
export const CREATE_SCAN_VARIANTS = {
  [ScanMode.SINGLE_URL]: CreateSingleUrlScanDto,
  [ScanMode.URL_LIST]: CreateUrlListScanDto,
  [ScanMode.CRAWL]: CreateCrawlScanDto,
} as const;

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
        basicAuth: {
          username: 'scanner-user',
          password: 'scanner-password',
        },
      },
      aiAudit: {},
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
        strategy: 'same_hostname',
        globs: ['https://example.com/docs/**'],
        excludeGlobs: ['**/private/**'],
      },
    },
  },
};
