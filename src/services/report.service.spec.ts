import { Test, TestingModule } from '@nestjs/testing';
import { ReportService } from './report.service';
import { BrowserService } from './browser.service';
import { ScanResponseDto } from '../dto/scan/response/scan-response.dto';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';

function makeScan(overrides: Partial<ScanResponseDto> = {}): ScanResponseDto {
  return {
    id: 1,
    mode: ScanMode.SINGLE_URL,
    targets: ['https://example.com'],
    status: ScanStatus.COMPLETED,
    scanOptions: { rootElement: null, ruleIds: null },
    crawlOptions: null,
    progress: { pagesDiscovered: 1, pagesScanned: 1, pagesFailed: 0 },
    violations: [],
    totalIssueCount: 0,
    aiAudit: null,
    agentFindings: [],
    createdAt: new Date('2025-06-14T10:30:00.000Z'),
    updatedAt: new Date('2025-06-14T10:31:00.000Z'),
    ...overrides,
  };
}

describe('ReportService', () => {
  let service: ReportService;
  let mockBrowserService: jest.Mocked<BrowserService>;

  const mockPage = {
    setContent: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newPage: jest.fn().mockResolvedValue(mockPage),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportService,
        {
          provide: BrowserService,
          useValue: {
            getBrowser: jest.fn().mockResolvedValue(mockBrowser),
          },
        },
      ],
    }).compile();

    service = module.get<ReportService>(ReportService);
    mockBrowserService = module.get(BrowserService);
  });

  describe('generateHtml', () => {
    it('returns a valid HTML5 document', () => {
      const html = service.generateHtml(makeScan());
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toMatch(/<html lang="en">/);
    });

    it('includes the scan ID in the title and header', () => {
      const html = service.generateHtml(makeScan({ id: 42 }));
      expect(html).toContain('Scan #42');
      expect(html).toContain('<title>Accessibility Report — Scan #42</title>');
    });

    it('shows "No Violations Found" for clean scans', () => {
      const html = service.generateHtml(
        makeScan({ violations: [], totalIssueCount: 0 }),
      );
      expect(html).toContain('No Violations Found');
    });

    it('renders rule ID, impact badge and description for violations', () => {
      const scan = makeScan({
        violations: [
          {
            rule: {
              id: 'color-contrast',
              description: 'Ensure sufficient contrast',
              helpUrl:
                'https://dequeuniversity.com/rules/axe/4.11/color-contrast',
            },
            impact: IssueImpact.SERIOUS,
            issues: [
              {
                id: 1,
                pageUrl: 'https://example.com',
                selector: '.btn',
                context: '<button>',
              },
            ],
          },
        ],
        totalIssueCount: 1,
      });
      const html = service.generateHtml(scan);
      expect(html).toContain('color-contrast');
      expect(html).toContain('serious');
      expect(html).toContain('Ensure sufficient contrast');
      expect(html).toContain('.btn');
      expect(html).toContain('&lt;button&gt;');
    });

    it('sorts violations critical → serious → moderate → minor', () => {
      const scan = makeScan({
        violations: [
          {
            rule: { id: 'rule-minor', description: '', helpUrl: null },
            impact: IssueImpact.MINOR,
            issues: [],
          },
          {
            rule: { id: 'rule-critical', description: '', helpUrl: null },
            impact: IssueImpact.CRITICAL,
            issues: [],
          },
          {
            rule: { id: 'rule-moderate', description: '', helpUrl: null },
            impact: IssueImpact.MODERATE,
            issues: [],
          },
          {
            rule: { id: 'rule-serious', description: '', helpUrl: null },
            impact: IssueImpact.SERIOUS,
            issues: [],
          },
        ],
        totalIssueCount: 0,
      });
      const html = service.generateHtml(scan);
      expect(html.indexOf('rule-critical')).toBeLessThan(
        html.indexOf('rule-serious'),
      );
      expect(html.indexOf('rule-serious')).toBeLessThan(
        html.indexOf('rule-moderate'),
      );
      expect(html.indexOf('rule-moderate')).toBeLessThan(
        html.indexOf('rule-minor'),
      );
    });

    it('does not mutate the original violations array ordering', () => {
      const violations = [
        {
          rule: { id: 'rule-minor', description: '', helpUrl: null },
          impact: IssueImpact.MINOR,
          issues: [],
        },
        {
          rule: { id: 'rule-critical', description: '', helpUrl: null },
          impact: IssueImpact.CRITICAL,
          issues: [],
        },
      ];
      const scan = makeScan({ violations, totalIssueCount: 0 });
      service.generateHtml(scan);
      expect(scan.violations[0].rule.id).toBe('rule-minor');
    });

    it('escapes HTML entities in user-controlled fields', () => {
      const scan = makeScan({
        violations: [
          {
            rule: { id: 'rule-x', description: 'Desc &amp;', helpUrl: null },
            impact: IssueImpact.MINOR,
            issues: [
              {
                id: 1,
                pageUrl: null,
                selector: '<script>alert(1)</script>',
                context: '<img onerror=alert(1)>',
              },
            ],
          },
        ],
        totalIssueCount: 1,
      });
      const html = service.generateHtml(scan);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<img onerror=alert(1)>');
      expect(html).toContain('&lt;img');
    });

    it('renders null issue fields as em-dash', () => {
      const scan = makeScan({
        violations: [
          {
            rule: { id: 'rule-x', description: 'Desc', helpUrl: null },
            impact: IssueImpact.MINOR,
            issues: [{ id: 1, pageUrl: null, selector: null, context: null }],
          },
        ],
        totalIssueCount: 1,
      });
      const html = service.generateHtml(scan);
      expect(html).toContain('—');
    });

    it('renders Scan Options section when rootElement is set', () => {
      const html = service.generateHtml(
        makeScan({ scanOptions: { rootElement: 'main', ruleIds: null } }),
      );
      expect(html).toContain('Scan Options');
      expect(html).toContain('main');
    });

    it('renders Scan Options section when ruleIds are set', () => {
      const html = service.generateHtml(
        makeScan({
          scanOptions: {
            rootElement: null,
            ruleIds: ['color-contrast', 'image-alt'],
          },
        }),
      );
      expect(html).toContain('Scan Options');
      expect(html).toContain('color-contrast');
      expect(html).toContain('image-alt');
    });

    it('omits Scan Options section when both options are null', () => {
      const html = service.generateHtml(
        makeScan({ scanOptions: { rootElement: null, ruleIds: null } }),
      );
      expect(html).not.toContain('Scan Options');
    });

    it('renders Crawl Options section for crawl scans', () => {
      const scan = makeScan({
        mode: ScanMode.CRAWL,
        crawlOptions: {
          maxPages: 50,
          maxDepth: 3,
          strategy: CrawlStrategy.SameHostname,
          globs: ['https://example.com/blog/**'],
          excludeGlobs: ['**/admin/**'],
        },
      });
      const html = service.generateHtml(scan);
      expect(html).toContain('Crawl Options');
      expect(html).toContain('50');
      expect(html).toContain('blog');
      expect(html).toContain('admin');
    });

    it('omits Crawl Options section for single_url scans', () => {
      const html = service.generateHtml(
        makeScan({ mode: ScanMode.SINGLE_URL, crawlOptions: null }),
      );
      expect(html).not.toContain('Crawl Options');
    });

    it('shows documentation link when helpUrl is present', () => {
      const scan = makeScan({
        violations: [
          {
            rule: {
              id: 'r',
              description: 'D',
              helpUrl: 'https://dequeuniversity.com/rules',
            },
            impact: IssueImpact.MINOR,
            issues: [],
          },
        ],
        totalIssueCount: 0,
      });
      expect(service.generateHtml(scan)).toContain(
        'https://dequeuniversity.com/rules',
      );
    });

    it('omits documentation link when helpUrl is null', () => {
      const scan = makeScan({
        violations: [
          {
            rule: { id: 'r', description: 'D', helpUrl: null },
            impact: IssueImpact.MINOR,
            issues: [],
          },
        ],
        totalIssueCount: 0,
      });
      expect(service.generateHtml(scan)).not.toContain('View documentation');
    });

    it('includes skip link and ARIA landmarks', () => {
      const html = service.generateHtml(makeScan());
      expect(html).toContain('href="#main"');
      expect(html).toContain('role="banner"');
      expect(html).toContain('role="main"');
      expect(html).toContain('role="contentinfo"');
    });

    it('includes summary stats cards', () => {
      const scan = makeScan({
        violations: [],
        totalIssueCount: 0,
        progress: { pagesDiscovered: 5, pagesScanned: 4, pagesFailed: 1 },
      });
      const html = service.generateHtml(scan);
      expect(html).toContain('Pages Scanned');
      expect(html).toContain('Pages Failed');
      expect(html).toContain('Violation Types');
      expect(html).toContain('Total Issues');
    });
  });

  describe('generatePdf', () => {
    it('calls getBrowser, creates a page, sets HTML content, and returns a Buffer', async () => {
      const scan = makeScan();
      const result = await service.generatePdf(scan);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked member access, not an unbound call
      expect(mockBrowserService.getBrowser).toHaveBeenCalledTimes(1);
      expect(mockBrowser.newPage).toHaveBeenCalledTimes(1);
      expect(mockPage.setContent).toHaveBeenCalledWith(
        expect.stringContaining('<!DOCTYPE html>'),
        { waitUntil: 'load' },
      );
      expect(mockPage.pdf).toHaveBeenCalledWith({
        format: 'A4',
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
        printBackground: true,
      });
      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(Buffer);
    });

    it('closes the page even if pdf() throws', async () => {
      mockPage.pdf.mockRejectedValueOnce(new Error('PDF error'));
      await expect(service.generatePdf(makeScan())).rejects.toThrow(
        'PDF error',
      );
      expect(mockPage.close).toHaveBeenCalledTimes(1);
    });
  });
});
