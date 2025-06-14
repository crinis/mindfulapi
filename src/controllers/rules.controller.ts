import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { RulesService } from '../services/rules.service';
import { RulesQueryDto } from '../dto/rules-query.dto';
import { RuleResponseDto } from '../dto/scan-response.dto';

/**
 * REST API controller for accessibility scanner rules.
 * 
 * Provides endpoints for retrieving available accessibility rules
 * for different scanner types. This enables clients to discover
 * what rules are available for each scanner and their metadata.
 * 
 * @route /rules
 */
@Controller('rules')
export class RulesController {
  constructor(private readonly rulesService: RulesService) {}

  /**
   * Retrieves all available rules for a specific scanner type.
   * 
   * Returns a comprehensive list of accessibility rules supported by
   * the specified scanner, including rule IDs, descriptions, impact levels,
   * and help URLs for remediation guidance.
   * 
   * This endpoint is useful for:
   * - Discovering available rules for a scanner
   * - Building rule-specific documentation
   * - Creating rule filtering interfaces
   * - Understanding rule coverage differences between scanners
   * 
   * @param query - Query parameters specifying scanner type and language
   * @returns Array of rule response DTOs with complete rule metadata
   * @throws {BadRequestException} When scanner type is invalid
   * @throws {InternalServerErrorException} When rule loading fails
   * 
   * @example
   * GET /rules?scannerType=axe
   * GET /rules?scannerType=htmlcs&language=es
   */
  @Get()
  async getRules(@Query() query: RulesQueryDto): Promise<RuleResponseDto[]> {
    return this.rulesService.getRulesForScanner(
      query.scannerType,
      query.language,
    );
  }
}
