import {
  Controller,
  Get,
  Post,
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
import { ScanResponseDto } from '../dto/scan/response';
import { ErrorResponseDto } from '../dto/error-response.dto';
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
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    type: ErrorResponseDto,
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
   * Creates a new scan run and sets the resource `Location` header.
   */
  async create(
    @Body() createScanDto: CreateScanDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScanResponseDto> {
    const scan = await this.scanService.create(createScanDto);
    response.location(`/scans/${scan.id}`);
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
  @ApiResponse({
    status: 400,
    description: 'Invalid query parameters',
    type: ErrorResponseDto,
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
  @ApiParam({ name: 'id', description: 'Scan ID', type: Number, example: 1 })
  @ApiResponse({
    status: 200,
    description: 'Scan found',
    type: ScanResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'ID must be a positive integer',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid Bearer token',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Scan not found',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Unexpected server error',
    type: ErrorResponseDto,
  })
  /**
   * Returns one scan run by numeric identifier.
   */
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ScanResponseDto> {
    return this.scanService.findOne(id);
  }
}
