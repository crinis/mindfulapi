import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { ScanService } from '../services/scan.service';
import { ReportService } from '../services/report.service';
import { ErrorResponseDto } from '../dto/error-response.dto';

/**
 * REST API controller for generating accessibility reports from scan data.
 * @route /scans/:id/reports
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('scans/:id/reports')
export class ReportController {
  constructor(
    private readonly scanService: ScanService,
    private readonly reportService: ReportService,
  ) {}

  @Get('html')
  @ApiOperation({
    operationId: 'getHtmlReport',
    summary: 'Generate an HTML accessibility report for a scan',
    description: 'Returns a full standalone HTML accessibility report.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scan ID',
    schema: { type: 'integer', minimum: 1 },
    example: 1,
  })
  @ApiResponse({
    status: 200,
    description: 'HTML accessibility report',
    content: { 'text/html': { schema: { type: 'string' } } },
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
  @Header('Content-Type', 'text/html; charset=utf-8')
  /**
   * Returns a complete standalone HTML accessibility report for the given scan.
   */
  async getHtmlReport(@Param('id', ParseIntPipe) id: number): Promise<string> {
    const scan = await this.scanService.findOne(id);
    return this.reportService.generateHtml(scan);
  }

  @Get('pdf')
  @ApiOperation({
    operationId: 'getPdfReport',
    summary: 'Generate a PDF accessibility report for a scan',
    description: 'Returns a generated PDF accessibility report.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scan ID',
    schema: { type: 'integer', minimum: 1 },
    example: 1,
  })
  @ApiResponse({
    status: 200,
    description: 'PDF accessibility report',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
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
   * Returns a PDF accessibility report for the given scan as a downloadable file.
   */
  async getPdfReport(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<StreamableFile> {
    const scan = await this.scanService.findOne(id);
    const buffer = await this.reportService.generatePdf(scan);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="scan-${id}-report.pdf"`,
    });
  }
}
