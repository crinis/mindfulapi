import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HTTP Basic Authentication credentials used by the page scanner/browser context.
 */
export class BasicAuthCredentialsDto {
  /** Username for the protected target site. */
  @ApiProperty({
    example: 'scanner-user',
    minLength: 1,
    maxLength: 256,
    description: 'Username for HTTP Basic Authentication.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  username: string;

  /** Password for the protected target site. */
  @ApiProperty({
    example: 'scanner-password',
    minLength: 1,
    maxLength: 1024,
    description:
      'Password for HTTP Basic Authentication. Stored encrypted at rest.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password: string;
}

/**
 * Scan behavior options that apply to every mode.
 */
export class ScanOptionsDto {
  /** CSS selector to limit scan scope. When omitted, entire page is scanned. */
  @ApiPropertyOptional({
    example: 'main',
    description:
      'CSS selector to restrict the scan to a specific page region. Scans the entire page when omitted.',
    minLength: 1,
  })
  @IsOptional()
  @IsString()
  rootElement?: string;

  /** Specific axe rule IDs to run. When omitted, all rules run. */
  @ApiPropertyOptional({
    example: ['color-contrast', 'image-alt'],
    description:
      'Specific axe rule IDs to run. All rules run when omitted. See GET /rules for available IDs.',
    uniqueItems: true,
    minItems: 1,
    maxItems: 200,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  ruleIds?: string[];

  /** Optional credentials for scanning/crawling basic-auth protected pages. */
  @ApiPropertyOptional({
    type: () => BasicAuthCredentialsDto,
    description:
      'Optional HTTP Basic Authentication credentials used during page loading. ' +
      'They are sent only to the origin (scheme, host and port) of the first target URL, in answer to its 401 challenge. ' +
      'They are never sent to other origins: not to subresources, redirect targets or crawled pages on other hosts. ' +
      'If the target redirects to another origin (for example http to https, or example.com to www.example.com), use the final URL as the target. ' +
      'Split scans whose targets span several protected origins. ' +
      'Credentials are encrypted at rest and never returned in API responses.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BasicAuthCredentialsDto)
  basicAuth?: BasicAuthCredentialsDto;
}
