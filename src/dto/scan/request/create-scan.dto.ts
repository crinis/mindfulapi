import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
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

/**
 * Runtime DTO validated by class-validator.
 */
export class CreateScanDto {
  /** Scan execution mode determining which target fields are valid or required. */
  @ApiProperty({
    enum: ScanMode,
    description: 'How to choose pages for this scan run.',
    example: ScanMode.SINGLE_URL,
  })
  @IsEnum(ScanMode)
  mode: ScanMode;

  /** Single page target URL used only when `mode` is `single_url`. */
  @ApiPropertyOptional({
    example: 'https://example.com',
    description: 'Used when mode is single_url.',
  })
  @ValidateIf((o: CreateScanDto) => o.mode === ScanMode.SINGLE_URL)
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS)
  url?: string;

  /** Explicit list of page URLs used only when `mode` is `url_list`. */
  @ApiPropertyOptional({
    example: ['https://example.com', 'https://example.com/about'],
    description: 'Used when mode is url_list.',
    uniqueItems: true,
    minItems: 2,
    maxItems: 500,
  })
  @ValidateIf((o: CreateScanDto) => o.mode === ScanMode.URL_LIST)
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS, { each: true })
  urls?: string[];

  /** Seed URLs used only when `mode` is `crawl`. */
  @ApiPropertyOptional({
    example: ['https://example.com'],
    description: 'Used when mode is crawl.',
    uniqueItems: true,
    minItems: 1,
    maxItems: 50,
  })
  @ValidateIf((o: CreateScanDto) => o.mode === ScanMode.CRAWL)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS, { each: true })
  startUrls?: string[];

  /** Mode-agnostic scan settings forwarded to axe-core execution. */
  @ApiPropertyOptional({
    type: () => ScanOptionsDto,
    description:
      'Options controlling axe scan behavior regardless of run mode.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScanOptionsDto)
  scanOptions?: ScanOptionsDto;

  /** Crawl behavior settings applied only in crawl mode. */
  @ApiPropertyOptional({
    type: () => CrawlOptionsDto,
    description: 'Crawl-specific controls. Allowed only when mode is crawl.',
  })
  @ValidateIf((o: CreateScanDto) => o.mode === ScanMode.CRAWL)
  @ValidateNested()
  @Type(() => CrawlOptionsDto)
  crawlOptions?: CrawlOptionsDto;
}
