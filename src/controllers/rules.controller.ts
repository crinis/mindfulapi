import { Controller, Get } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RulesService } from '../services/rules.service';
import { RuleResponseDto } from '../dto/scan/response';
import { ErrorResponseDto } from '../dto/error-response.dto';

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
  @ApiOperation({
    operationId: 'listRules',
    summary: 'List all axe-core rules',
    description:
      'Returns all available axe-core accessibility rules with metadata, sorted alphabetically by ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of axe-core rules',
    type: RuleResponseDto,
    isArray: true,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid Bearer token',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Unexpected server error',
    type: ErrorResponseDto,
  })
  /**
   * Lists all available axe-core rules with response metadata.
   */
  getRules(): RuleResponseDto[] {
    return this.rulesService.getRules();
  }
}
