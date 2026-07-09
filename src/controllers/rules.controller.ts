import { Controller, Get, Header, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Response } from 'express';
import { version as axeVersion } from 'axe-core/package.json';
import { RulesService } from '../services/rules.service';
import { RuleResponseDto } from '../dto/scan/response';
import { ApiProblemResponses } from '../decorators/api-problem-responses.decorator';

/** Strong ETag for the rules list — changes only when axe-core is upgraded. */
const RULES_ETAG = `"axe-${axeVersion}"`;

/**
 * REST API controller for axe-core accessibility rules.
 * @route /rules
 */
@ApiTags('Rules')
@ApiBearerAuth()
@Controller('rules')
export class RulesController {
  /**
   * @param rulesService Service that exposes axe rule metadata.
   */
  constructor(private readonly rulesService: RulesService) {}

  @Get()
  // Rules are static per axe-core version; allow day-long caching.
  @Header('Cache-Control', 'public, max-age=86400')
  @Header('ETag', RULES_ETAG)
  @ApiOperation({
    operationId: 'listRules',
    summary: 'List all axe-core rules',
    description:
      'Returns all available axe-core accessibility rules with metadata, sorted alphabetically by ID. Cacheable; the ETag reflects the axe-core version.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of axe-core rules',
    type: RuleResponseDto,
    isArray: true,
  })
  @ApiResponse({ status: 304, description: 'Rules unchanged (ETag match)' })
  @ApiProblemResponses(401, 429, 500)
  /**
   * Lists all available axe-core rules, honoring If-None-Match for 304s.
   */
  getRules(
    @Res({ passthrough: true }) response: Response,
  ): RuleResponseDto[] | undefined {
    if (response.req.headers['if-none-match'] === RULES_ETAG) {
      response.status(304);
      return undefined;
    }
    return this.rulesService.getRules();
  }
}
