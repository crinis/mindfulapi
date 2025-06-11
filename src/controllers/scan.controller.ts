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
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ScanService } from '../services/scan.service';
import { CreateScanDto } from '../dto/create-scan.dto';
import { ScanResponseDto } from '../dto/scan-response.dto';

// Import for URL query DTO (without language)
import { ScanUrlQueryDto } from '../dto/scan-url-query.dto';

/**
 * REST API controller for managing accessibility scans.
 * 
 * Provides endpoints for creating new scans, retrieving scan results,
 * and querying scans by URL. All endpoints automatically generate
 * full URLs for screenshot resources based on the request context.
 * 
 * @route /scans
 */
@Controller('scans')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  /**
   * Determines the base URL for the current application instance.
   * 
   * Uses environment variable BASE_URL if configured (recommended for production),
   * otherwise dynamically detects from request headers. Handles reverse proxy
   * scenarios by checking x-forwarded-proto header.
   * 
   * @param req - Express request object containing headers
   * @returns The base URL (e.g., "https://api.example.com" or "http://localhost:3000")
   */
  private getBaseUrl(req: Request): string {
    // Use environment variable if set (recommended for production)
    if (process.env.BASE_URL) {
      return process.env.BASE_URL;
    }
    
    // Fall back to dynamic detection from request headers
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    return `${protocol}://${host}`;
  }

  /**
   * Creates a new accessibility scan and queues it for asynchronous processing.
   * 
   * The scan is created with PENDING status and immediately queued for background
   * processing using the configured job queue system.
   * 
   * @param createScanDto - Scan configuration including URL and language
   * @param req - Express request for base URL generation
   * @returns The created scan with PENDING status and generated screenshot URLs
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() createScanDto: CreateScanDto,
    @Req() req: Request,
  ): Promise<ScanResponseDto> {
    const baseUrl = this.getBaseUrl(req);
    return this.scanService.create(createScanDto, baseUrl);
  }

  /**
   * Retrieves all scans ordered by creation date (newest first).
   * 
   * Returns scans with complete issue details, rule information,
   * and full screenshot URLs for client consumption.
   * 
   * @param req - Express request for base URL generation
   * @returns Array of all scans with enriched violation data
   */
  @Get()
  async findAll(@Req() req: Request): Promise<ScanResponseDto[]> {
    const baseUrl = this.getBaseUrl(req);
    return this.scanService.findAll(baseUrl);
  }

  /**
   * Retrieves all scans for a specific URL.
   * 
   * Useful for tracking scan history and results for a particular webpage
   * over time. Results are ordered by creation date (newest first).
   * 
   * @param query - Query parameters containing the target URL
   * @param req - Express request for base URL generation
   * @returns Array of scans for the specified URL with enriched violation data
   */
  @Get('by-url')
  async findByUrl(
    @Query() query: ScanUrlQueryDto,
    @Req() req: Request,
  ): Promise<ScanResponseDto[]> {
    const baseUrl = this.getBaseUrl(req);
    return this.scanService.findByUrl(query.url, baseUrl);
  }

  /**
   * Retrieves a specific scan by its unique identifier.
   * 
   * Returns complete scan details including all accessibility violations,
   * issue details, help URLs, and screenshot links.
   * 
   * @param id - Unique scan identifier
   * @param req - Express request for base URL generation
   * @returns The scan with enriched violation data and screenshot URLs
   * @throws {NotFoundException} When scan with specified ID doesn't exist
   */
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ): Promise<ScanResponseDto> {
    const baseUrl = this.getBaseUrl(req);
    return this.scanService.findOne(id, baseUrl);
  }
}
