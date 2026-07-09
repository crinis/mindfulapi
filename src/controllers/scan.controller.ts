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
  CreateScanDto,
  CreateSingleUrlScanDto,
  CreateUrlListScanDto,
  CreateCrawlScanDto,
  createScanRequestExamples,
  createScanRequestOneOfSchema,
} from '../dto/scan/request';
import { ScanQueryDto } from '../dto/scan-query.dto';
import { ScanByIdQueryDto } from '../dto/scan-by-id-query.dto';
import { ScanResponseDto } from '../dto/scan/response';
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
  @ApiProblemResponses(400, 401, 429, 500)
  /**
   * Creates a new scan run and sets the resource `Location` header.
   */
  async create(
    @Body() createScanDto: CreateScanDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScanResponseDto> {
    const scan = await this.scanService.create(createScanDto);
    response.location(`/v1/scans/${scan.id}`);
    return scan;
  }

  @Get()
  @ApiOperation({
    operationId: 'listScans',
    summary: 'List all scan runs',
    description:
      'Returns all scan runs ordered by creation date, newest first. Use the optional `target` query parameter to filter runs by one of their input targets.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of scans',
    type: ScanResponseDto,
    isArray: true,
  })
  @ApiProblemResponses(400, 401, 429, 500)
  /**
   * Returns all scan runs, optionally filtered by a normalized target URL.
   */
  async findAll(@Query() query: ScanQueryDto): Promise<ScanResponseDto[]> {
    return this.scanService.findAll(
      query.target ? { target: query.target } : undefined,
    );
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
