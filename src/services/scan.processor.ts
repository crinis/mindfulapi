import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanJobData } from './scan-queue.service';
import { BrowserService } from './browser.service';
import {
  AxeAccessibilityScanner,
  ScanOptions,
} from './axe-accessibility-scanner.service';

/**
 * Background job processor for asynchronous accessibility scan execution.
 */
@Injectable()
@Processor('scan-processing')
export class ScanProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanProcessor.name);

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    @InjectRepository(Issue)
    private readonly issueRepository: Repository<Issue>,
    private readonly browserService: BrowserService,
    private readonly scanner: AxeAccessibilityScanner,
  ) {
    super();
  }

  async process(job: Job<ScanJobData>): Promise<void> {
    const { scanId, url, rootElement, ruleIds } = job.data;

    this.logger.log(`Processing scan ${scanId} for URL: ${url}`);

    try {
      await this.updateScanStatus(scanId, ScanStatus.RUNNING);
      await this.performScan(scanId, url, rootElement, ruleIds);
      await this.updateScanStatus(scanId, ScanStatus.COMPLETED);
      this.logger.log(`Completed scan ${scanId}`);
    } catch (error) {
      this.logger.error(`Failed scan ${scanId}:`, error);
      await this.updateScanStatus(scanId, ScanStatus.FAILED);
      throw error;
    }
  }

  private async performScan(
    scanId: number,
    url: string,
    rootElement?: string,
    ruleIds?: string[],
  ): Promise<void> {
    const browser = await this.browserService.getBrowser();

    const scanOptions: ScanOptions = {};
    if (rootElement) scanOptions.rootElement = rootElement;
    if (ruleIds?.length) scanOptions.ruleIds = ruleIds;

    const partialIssues = await this.scanner.scan(url, browser, scanOptions);

    for (const partial of partialIssues) {
      const issue = this.issueRepository.create({
        scan: { id: scanId } as Pick<Scan, 'id'>,
        ruleId: partial.ruleId!,
        description: partial.description,
        impact: partial.impact,
        selector: partial.selector,
        context: partial.context,
        helpUrl: partial.helpUrl,
      });
      await this.issueRepository.save(issue);
    }

    this.logger.log(`Saved ${partialIssues.length} issues for scan ${scanId}`);
  }

  private async updateScanStatus(
    scanId: number,
    status: ScanStatus,
  ): Promise<void> {
    await this.scanRepository.update(scanId, { status });
  }
}
