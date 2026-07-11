import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpStatus,
  HttpCode,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiExtraModels,
  ApiQuery,
} from '@nestjs/swagger';
import { ScanService } from '../services/scan.service';
import {
  CreateScanRequest,
  CreateSingleUrlScanDto,
  CreateUrlListScanDto,
  CreateCrawlScanDto,
  createScanRequestExamples,
  createScanRequestOneOfSchema,
} from '../dto/scan/request';
import { DiscriminatedBodyPipe } from '../pipes/discriminated-body.pipe';
import { ScanQueryDto } from '../dto/scan-query.dto';
import { ScanByIdQueryDto } from '../dto/scan-by-id-query.dto';
import { ScanResponseDto, ScanSummaryResponseDto } from '../dto/scan/response';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../dto/pagination/paginated-response.dto';
import { ApiProblemResponses } from '../decorators/api-problem-responses.decorator';
import { Response } from 'express';

/**
 * REST API controller for managing accessibility scans.
 * @route /scans
 */
@ApiTags('Scans')
@ApiBearerAuth()
@Controller('scans')
export class ScanController {
  /**
   * @param scanService Application service handling scan lifecycle operations.
   */
  constructor(private readonly scanService: ScanService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiExtraModels(
    CreateSingleUrlScanDto,
    CreateUrlListScanDto,
    CreateCrawlScanDto,
  )
  @ApiOperation({
    operationId: 'createScan',
    summary: 'Start a new accessibility scan run',
    description:
      'Queues a new axe-core scan run in one of three modes: single URL, URL list, or crawl. Processing runs asynchronously in the background. Poll GET /scans/:id for status and results.',
  })
  @ApiBody({
    schema: createScanRequestOneOfSchema,
    examples: createScanRequestExamples,
  })
  @ApiResponse({
    status: 201,
    description: 'Scan run created and queued',
    headers: {
      Location: {
        description: 'URL of the created scan run resource',
        schema: { type: 'string', format: 'uri-reference' },
      },
    },
    type: ScanResponseDto,
  })
  @ApiProblemResponses(400, 401, 429, 500, 503)
  /**
   * Creates a new scan run and sets the resource `Location` header.
   */
  async create(
    @Body(DiscriminatedBodyPipe) createScanDto: CreateScanRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScanResponseDto> {
    const scan = await this.scanService.create(createScanDto);
    response.location(`/v1/scans/${scan.id}`);
    return scan;
  }

  @Get()
  @ApiOperation({
    operationId: 'listScans',
    summary: 'List scan runs',
    description:
      'Returns a page of scan run summaries ordered by creation date, newest first. Summaries omit per-issue detail and expose per-severity issue counts instead. Use `limit`/`offset` to paginate and the optional `target` query parameter to filter runs by one of their input targets.',
  })
  @ApiPaginatedResponse(ScanSummaryResponseDto)
  @ApiProblemResponses(400, 401, 429, 500)
  /**
   * Returns a page of scan summaries, optionally filtered by a normalized target URL.
   */
  async findAll(
    @Query() query: ScanQueryDto,
  ): Promise<PaginatedResponseDto<ScanSummaryResponseDto>> {
    return this.scanService.findAll({
      limit: query.limit,
      offset: query.offset,
      target: query.target,
    });
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getScanById',
    summary: 'Get scan by ID',
    description: 'Returns a specific scan with full violation details.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scan ID',
    schema: { type: 'integer', minimum: 1 },
    example: 1,
  })
  @ApiQuery({
    name: 'pageUrls',
    required: false,
    isArray: true,
    explode: true,
    description:
      'Filter returned violations to those with at least one issue on any of the given page URLs. Repeat the parameter for multiple values: ?pageUrls=https://a.com&pageUrls=https://b.com',
    example: ['https://example.com/about'],
  })
  @ApiResponse({
    status: 200,
    description: 'Scan found',
    type: ScanResponseDto,
  })
  @ApiProblemResponses(400, 401, 404, 429, 500)
  /**
   * Returns one scan run by numeric identifier.
   */
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ScanByIdQueryDto,
  ): Promise<ScanResponseDto> {
    return this.scanService.findOne(id, query.pageUrls);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'cancelScan',
    summary: 'Cancel a scan run',
    description:
      'Cancels a pending or running scan. A queued job is removed; a running scan stops cooperatively between pages. Returns 409 if the scan is already in a terminal state.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scan ID',
    schema: { type: 'integer', minimum: 1 },
    example: 1,
  })
  @ApiResponse({
    status: 200,
    description: 'Scan canceled',
    type: ScanResponseDto,
  })
  @ApiProblemResponses(400, 401, 404, 409, 429, 500)
  /**
   * Cancels a pending or running scan run.
   */
  async cancel(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ScanResponseDto> {
    return this.scanService.cancel(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'deleteScan',
    summary: 'Delete a scan run',
    description: 'Permanently deletes a scan run and all of its stored issues.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scan ID',
    schema: { type: 'integer', minimum: 1 },
    example: 1,
  })
  @ApiResponse({
    status: 204,
    description: 'Scan deleted',
  })
  @ApiProblemResponses(400, 401, 404, 429, 500)
  /**
   * Deletes one scan run by numeric identifier.
   */
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.scanService.remove(id);
  }
}
