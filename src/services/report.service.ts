import { Injectable } from '@nestjs/common';
import { BrowserService } from './browser.service';
import { ScanResponseDto } from '../dto/scan/response/scan-response.dto';
import { IssueImpact } from '../enums/issue-impact.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { ViolationResponseDto } from '../dto/scan/response/violation-response.dto';

const IMPACT_ORDER: IssueImpact[] = [
  IssueImpact.CRITICAL,
  IssueImpact.SERIOUS,
  IssueImpact.MODERATE,
  IssueImpact.MINOR,
];

const REPORT_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: #f9fafb;
    color: #111827;
    font-size: 15px;
    line-height: 1.6;
  }
  .skip-link {
    position: absolute;
    top: -40px;
    left: 0;
    background: #1e40af;
    color: #fff;
    padding: 8px 16px;
    z-index: 100;
    font-weight: 600;
    text-decoration: none;
    border-radius: 0 0 4px 0;
  }
  .skip-link:focus { top: 0; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
    border: 0;
  }
  /* Header */
  .site-header {
    background: #0f172a;
    color: #f8fafc;
    padding: 28px 40px 24px;
  }
  .site-header h1 {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 8px;
  }
  .header-meta {
    font-size: 0.875rem;
    color: #94a3b8;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .header-meta time { color: #cbd5e1; }
  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .badge-status-completed { background: #dcfce7; color: #166534; }
  .badge-status-running   { background: #dbeafe; color: #1e40af; }
  .badge-status-pending   { background: #fef9c3; color: #854d0e; }
  .badge-status-failed    { background: #fee2e2; color: #991b1b; }
  .badge-critical  { background: #fee2e2; color: #991b1b; }
  .badge-serious   { background: #ffedd5; color: #9a3412; }
  .badge-moderate  { background: #fef9c3; color: #854d0e; }
  .badge-minor     { background: #dcfce7; color: #166534; }
  /* Layout */
  main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 48px; }
  /* Section headings */
  .section-title {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 8px;
    margin-bottom: 20px;
  }
  section { margin-bottom: 40px; }
  /* Stat cards */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
  }
  .stat-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 20px 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .stat-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 2rem;
    font-weight: 800;
    line-height: 1;
  }
  .stat-value.good   { color: #166534; }
  .stat-value.bad    { color: #991b1b; }
  .stat-value.warn   { color: #854d0e; }
  .stat-value.neutral{ color: #111827; }
  /* Targets */
  .target-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .target-list li a {
    color: #1d4ed8;
    text-decoration: none;
    word-break: break-all;
  }
  .target-list li a:hover { text-decoration: underline; }
  /* Definition lists */
  dl.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 20px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 16px 20px;
  }
  dl.details dt {
    font-weight: 600;
    color: #374151;
    font-size: 0.875rem;
  }
  dl.details dd {
    color: #6b7280;
    font-size: 0.875rem;
    word-break: break-word;
  }
  /* Success box */
  .success-box {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #f0fdf4;
    border: 1px solid #86efac;
    border-radius: 10px;
    padding: 20px 24px;
    color: #166534;
    font-weight: 600;
  }
  .success-icon { font-size: 1.5rem; }
  /* Violation articles */
  .violation {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    margin-bottom: 20px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .violation-header {
    padding: 16px 20px;
    border-bottom: 1px solid #f3f4f6;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .violation-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .violation h3 { font-size: 1rem; font-weight: 700; }
  .rule-chip {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.78rem;
    background: #f1f5f9;
    color: #334155;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
    white-space: nowrap;
  }
  .violation-description { font-size: 0.875rem; color: #374151; }
  .violation-link { font-size: 0.8rem; color: #1d4ed8; text-decoration: none; }
  .violation-link:hover { text-decoration: underline; }
  /* Issues table */
  .table-wrapper { overflow-x: auto; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  th {
    background: #f8fafc;
    text-align: left;
    padding: 10px 14px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    border-bottom: 1px solid #e5e7eb;
  }
  td {
    padding: 10px 14px;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: top;
    word-break: break-word;
  }
  tr:last-child td { border-bottom: none; }
  td.null-val { color: #9ca3af; font-style: italic; }
  td.num-col { color: #6b7280; text-align: right; width: 3rem; }
  td code {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.78rem;
    background: #f1f5f9;
    padding: 1px 5px;
    border-radius: 3px;
  }
  /* Footer */
  .site-footer {
    background: #0f172a;
    color: #64748b;
    text-align: center;
    padding: 16px;
    font-size: 0.8125rem;
  }
  /* Print */
  @media print {
    .skip-link { display: none; }
    body { background: #fff; }
    .site-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .badge, .rule-chip, .stat-card { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .violation { page-break-inside: avoid; }
    a[href]::after { content: none !important; }
  }
`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Service for generating HTML and PDF accessibility reports from scan data.
 */
@Injectable()
export class ReportService {
  constructor(private readonly browserService: BrowserService) {}

  /**
   * Generates a complete self-contained HTML accessibility report.
   *
   * @param scan The scan response data to render.
   * @returns A complete HTML5 document string.
   */
  generateHtml(scan: ScanResponseDto): string {
    const sortedViolations = [...scan.violations].sort(
      (a, b) =>
        IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact),
    );

    const statusBadgeClass = `badge badge-status-${escapeHtml(scan.status)}`;
    const formattedDate = formatDate(scan.createdAt);
    const isoDate = new Date(scan.createdAt).toISOString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accessibility Report — Scan #${scan.id}</title>
  <style>${REPORT_STYLES}</style>
</head>
<body>
  <a href="#main" class="skip-link">Skip to main content</a>

  <header role="banner" class="site-header">
    <h1>Accessibility Report</h1>
    <div class="header-meta">
      <span>Scan #${scan.id}</span>
      <span>Mode: ${escapeHtml(scan.mode)}</span>
      <time datetime="${escapeHtml(isoDate)}">${escapeHtml(formattedDate)}</time>
      <span class="${statusBadgeClass}" aria-label="Status: ${escapeHtml(scan.status)}">${escapeHtml(scan.status)}</span>
    </div>
  </header>

  <main id="main" role="main">

    ${this.renderSummarySection(scan)}
    ${this.renderTargetsSection(scan)}
    ${this.renderScanOptionsSection(scan)}
    ${this.renderCrawlOptionsSection(scan)}
    ${this.renderViolationsSection(sortedViolations)}

  </main>

  <footer role="contentinfo" class="site-footer">
    Generated by MindfulAPI &middot; <time datetime="${escapeHtml(isoDate)}">${escapeHtml(formattedDate)}</time>
  </footer>
</body>
</html>`;
  }

  /**
   * Generates a PDF accessibility report from the scan data.
   *
   * @param scan The scan response data to render.
   * @returns A Buffer containing the PDF binary data.
   */
  async generatePdf(scan: ScanResponseDto): Promise<Buffer> {
    const html = this.generateHtml(scan);
    const browser = await this.browserService.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
        printBackground: true,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  private renderSummarySection(scan: ScanResponseDto): string {
    const violationCount = scan.violations.length;
    const issueCount = scan.totalIssueCount;
    const pagesScanned = scan.progress.pagesScanned;
    const pagesFailed = scan.progress.pagesFailed;

    const violationClass = violationCount > 0 ? 'bad' : 'good';
    const issueClass = issueCount > 0 ? 'bad' : 'good';
    const failedClass = pagesFailed > 0 ? 'warn' : 'neutral';

    return `<section aria-labelledby="summary-heading">
      <h2 id="summary-heading" class="section-title">Summary</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Violation Types</div>
          <div class="stat-value ${violationClass}">${violationCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Issues</div>
          <div class="stat-value ${issueClass}">${issueCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Pages Scanned</div>
          <div class="stat-value neutral">${pagesScanned}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Pages Failed</div>
          <div class="stat-value ${failedClass}">${pagesFailed}</div>
        </div>
      </div>
    </section>`;
  }

  private renderTargetsSection(scan: ScanResponseDto): string {
    const items = scan.targets
      .map(
        (t) =>
          `<li><a href="${escapeHtml(t)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t)}</a></li>`,
      )
      .join('\n        ');

    return `<section aria-labelledby="targets-heading">
      <h2 id="targets-heading" class="section-title">Scan Targets</h2>
      <ul class="target-list">
        ${items}
      </ul>
    </section>`;
  }

  private renderScanOptionsSection(scan: ScanResponseDto): string {
    const { rootElement, ruleIds } = scan.scanOptions;
    if (rootElement === null && ruleIds === null) return '';

    const rows: string[] = [];
    if (rootElement !== null) {
      rows.push(
        `<dt>Root Element</dt><dd><code>${escapeHtml(rootElement)}</code></dd>`,
      );
    }
    if (ruleIds !== null) {
      rows.push(
        `<dt>Rule IDs</dt><dd>${ruleIds.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ')}</dd>`,
      );
    }

    return `<section aria-labelledby="scan-options-heading">
      <h2 id="scan-options-heading" class="section-title">Scan Options</h2>
      <dl class="details">
        ${rows.join('\n        ')}
      </dl>
    </section>`;
  }

  private renderCrawlOptionsSection(scan: ScanResponseDto): string {
    if (scan.mode !== ScanMode.CRAWL || !scan.crawlOptions) return '';

    const co = scan.crawlOptions;
    const rows: string[] = [
      `<dt>Max Pages</dt><dd>${co.maxPages}</dd>`,
      `<dt>Max Depth</dt><dd>${co.maxDepth}</dd>`,
      `<dt>Strategy</dt><dd>${escapeHtml(co.strategy)}</dd>`,
    ];

    if (co.globs.length > 0) {
      rows.push(
        `<dt>Include Globs</dt><dd>${co.globs.map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')}</dd>`,
      );
    }
    if (co.excludeGlobs.length > 0) {
      rows.push(
        `<dt>Exclude Globs</dt><dd>${co.excludeGlobs.map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')}</dd>`,
      );
    }

    return `<section aria-labelledby="crawl-options-heading">
      <h2 id="crawl-options-heading" class="section-title">Crawl Options</h2>
      <dl class="details">
        ${rows.join('\n        ')}
      </dl>
    </section>`;
  }

  private renderViolationsSection(
    violations: ViolationResponseDto[],
  ): string {
    const content =
      violations.length === 0
        ? `<div class="success-box">
          <span class="success-icon" aria-hidden="true">✓</span>
          <span>No Violations Found</span>
        </div>`
        : violations.map((v) => this.renderViolation(v)).join('\n      ');

    return `<section aria-labelledby="violations-heading">
      <h2 id="violations-heading" class="section-title">Violations</h2>
      ${content}
    </section>`;
  }

  private renderViolation(v: ViolationResponseDto): string {
    const impactClass = `badge badge-${escapeHtml(v.impact)}`;
    const docLink = v.rule.helpUrl
      ? `<a href="${escapeHtml(v.rule.helpUrl)}" class="violation-link" target="_blank" rel="noopener noreferrer">View documentation ↗</a>`
      : '';

    const rows = v.issues
      .map((issue, idx) => {
        const urlCell = issue.pageUrl
          ? `<a href="${escapeHtml(issue.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.pageUrl)}</a>`
          : `<span class="null-val">—</span>`;
        const selectorCell = issue.selector
          ? `<code>${escapeHtml(issue.selector)}</code>`
          : `<span class="null-val">—</span>`;
        const contextCell = issue.context
          ? `<code>${escapeHtml(issue.context)}</code>`
          : `<span class="null-val">—</span>`;

        return `<tr>
              <td class="num-col">${idx + 1}</td>
              <td>${urlCell}</td>
              <td>${selectorCell}</td>
              <td>${contextCell}</td>
            </tr>`;
      })
      .join('\n          ');

    return `<article class="violation">
        <div class="violation-header">
          <div class="violation-title-row">
            <h3>
              <span class="rule-chip">${escapeHtml(v.rule.id)}</span>
            </h3>
            <span class="${impactClass}" aria-label="Impact: ${escapeHtml(v.impact)}">${escapeHtml(v.impact)}</span>
          </div>
          <p class="violation-description">${escapeHtml(v.rule.description)}</p>
          ${docLink}
        </div>
        <div class="table-wrapper">
          <table>
            <caption class="sr-only">Issues for rule ${escapeHtml(v.rule.id)}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Page URL</th>
                <th scope="col">Selector</th>
                <th scope="col">HTML Context</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </article>`;
  }
}
