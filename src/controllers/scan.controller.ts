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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ScanService } from '../services/scan.service';
import { CreateScanDto } from '../dto/create-scan.dto';
import { ScanQueryDto } from '../dto/scan-query.dto';
import { ScanResponseDto } from '../dto/scan-response.dto';
import { ErrorResponseDto } from '../dto/error-response.dto';

/**
 * REST API controller for managing accessibility scans.
 * @route /scans
 */
@ApiTags('Scans')
@ApiBearerAuth()
@Controller('scans')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new accessibility scan',
    description:
      'Queues a new axe-core accessibility scan for the given URL. The scan runs asynchronously in the background. Poll GET /scans/:id to check completion.',
  })
  @ApiBody({ type: CreateScanDto })
  @ApiResponse({
    status: 201,
    description: 'Scan created and queued',
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
  async create(@Body() createScanDto: CreateScanDto): Promise<ScanResponseDto> {
    return this.scanService.create(createScanDto);
  }

  @Get()
  @ApiOperation({
    summary: 'List all scans',
    description:
      'Returns all scans ordered by creation date, newest first. Use the optional `url` query parameter to filter scans for a specific URL.',
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
  async findAll(@Query() query: ScanQueryDto): Promise<ScanResponseDto[]> {
    return this.scanService.findAll(query.url ? { url: query.url } : undefined);
  }

  @Get(':id')
  @ApiOperation({
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
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ScanResponseDto> {
    return this.scanService.findOne(id);
  }
}
