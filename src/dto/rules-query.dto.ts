import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ScannerType } from '../enums/scanner-type.enum';
import { Language } from '../types/language.types';

/**
 * Data Transfer Object for rules endpoint query parameters.
 * 
 * This DTO defines the query parameters for retrieving accessibility rules
 * for specific scanner types and languages.
 */
export class RulesQueryDto {
  /**
   * Scanner type to retrieve rules for.
   * 
   * Determines which accessibility testing engine's rules will be returned.
   * This parameter is required to ensure the correct rule set is provided.
   * 
   * @example "htmlcs" for HTML_CodeSniffer rules
   * @example "axe" for Axe accessibility scanner rules
   */
  @IsEnum(ScannerType)
  scannerType: ScannerType;

  /**
   * Language preference for rule descriptions.
   * 
   * Determines the language used for rule descriptions and help content.
   * If not specified, defaults to English ('en'). The availability of
   * translations depends on the scanner's supported languages.
   * 
   * @example "en" for English (default)
   * @example "es" for Spanish
   * @example "fr" for French
   */
  @IsOptional()
  @IsString()
  language?: Language;
}
