import { Controller, Get, Res, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { HealthService } from '../services/health.service';
import { HealthResponseDto } from '../dto/health-response.dto';
import { Public } from '../decorators/public.decorator';

/**
 * Unauthenticated, version-neutral health/readiness probe.
 * @route /health
 */
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // @Public() only bypasses the auth guard; the global ThrottlerGuard still
  // applies, so a monitoring burst could otherwise 429 a healthy instance.
  @Get()
  @Public()
  @SkipThrottle()
  @Version(VERSION_NEUTRAL)
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Liveness and readiness probe',
    description:
      'Returns dependency health (database, Redis) plus browser connectivity and queue depth. Responds 200 when required dependencies are up, 503 otherwise. Unauthenticated.',
  })
  @ApiResponse({
    status: 200,
    description: 'Service healthy',
    type: HealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable',
    type: HealthResponseDto,
  })
  /**
   * Reports aggregate service health, setting a 503 status when degraded.
   */
  async getHealth(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthResponseDto> {
    const result = await this.healthService.check();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
