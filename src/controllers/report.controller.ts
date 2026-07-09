import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ScanService } from '../services/scan.service';
import { ReportService } from '../services/report.service';
import { ScanResponseDto } from '../dto/scan/response';
import { ApiProblemResponses } from '../decorators/api-problem-responses.decorator';

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

  /**
   * Strong validator for a scan's report. Completed scans are immutable, so the
   * updatedAt timestamp is a correct ETag; a match lets us skip rendering.
   */
  private reportEtag(scan: ScanResponseDto): string {
    return `"scan-${scan.id}-${new Date(scan.updatedAt).getTime()}"`;
  }

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
  @ApiResponse({ status: 304, description: 'Report unchanged (ETag match)' })
  @ApiProblemResponses(400, 401, 404, 429, 500)
  @Header('Content-Type', 'text/html; charset=utf-8')
  /**
   * Returns a complete standalone HTML accessibility report for the given scan.
   */
  async getHtmlReport(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string | undefined> {
    const scan = await this.scanService.findOne(id);
    const etag = this.reportEtag(scan);
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    if (response.req.headers['if-none-match'] === etag) {
      response.status(304);
      return undefined;
    }
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
  @ApiResponse({ status: 304, description: 'Report unchanged (ETag match)' })
  @ApiProblemResponses(400, 401, 404, 429, 500)
  /**
   * Returns a PDF accessibility report for the given scan as a downloadable file.
   */
  async getPdfReport(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const scan = await this.scanService.findOne(id);
    const etag = this.reportEtag(scan);
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    // Short-circuit before the expensive Playwright PDF render.
    if (response.req.headers['if-none-match'] === etag) {
      response.status(304);
      return undefined;
    }
    const buffer = await this.reportService.generatePdf(scan);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="scan-${id}-report.pdf"`,
    });
  }
}
