import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { CreateScanDto } from '../dto/create-scan.dto';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanQueueService } from './scan-queue.service';
import { ScanResponseDto } from '../dto/scan-response.dto';

/**
 * Core service for managing accessibility scans and their lifecycle.
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    private readonly scanQueueService: ScanQueueService,
  ) {}

  async create(createScanDto: CreateScanDto): Promise<ScanResponseDto> {
    const scan = this.scanRepository.create({
      url: createScanDto.url,
      rootElement: createScanDto.rootElement,
      status: ScanStatus.PENDING,
    });

    const savedScan = await this.scanRepository.save(scan);

    await this.scanQueueService.addScanJob(
      savedScan.id,
      createScanDto.url,
      createScanDto.rootElement,
      createScanDto.ruleIds,
    );

    return this.findOne(savedScan.id);
  }

  async findAll(options?: { url?: string }): Promise<ScanResponseDto[]> {
    const scans = await this.scanRepository.find({
      where: options?.url ? { url: options.url } : undefined,
      relations: ['issues'],
      order: { createdAt: 'DESC' },
    });

    return scans.map((scan) => this.enrichScanData(scan));
  }

  async findOne(id: number): Promise<ScanResponseDto> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    return this.enrichScanData(scan);
  }

  async remove(id: number): Promise<void> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    await this.scanRepository.remove(scan);
  }

  private enrichScanData(scan: Scan): ScanResponseDto {
    const rulesMap = new Map<string, Issue[]>();
    scan.issues.forEach((issue) => {
      if (!rulesMap.has(issue.ruleId)) {
        rulesMap.set(issue.ruleId, []);
      }
      rulesMap.get(issue.ruleId)!.push(issue);
    });

    let totalIssues = 0;
    const violations = Array.from(rulesMap.entries()).map(
      ([ruleId, issues]) => {
        totalIssues += issues.length;
        const first = issues[0];

        return {
          rule: {
            id: ruleId,
            description: first.description,
            helpUrl: first.helpUrl,
          },
          impact: first.impact,
          issues: issues.map((issue) => ({
            id: issue.id,
            selector: issue.selector,
            context: issue.context,
          })),
        };
      },
    );

    return {
      id: scan.id,
      url: scan.url,
      rootElement: scan.rootElement,
      status: scan.status,
      violations,
      totalIssueCount: totalIssues,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }
}
