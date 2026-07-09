import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { BrowserService } from '../src/services/browser.service';
import { scanConfig } from '../src/config/configuration';
import {
  ImageAltTextSkill,
  type ImageEvidence,
} from '../src/agent/skills/image-alt-text.skill';
import type { CollectContext } from '../src/agent/skills/audit-skill.interface';
import type { ScannedIssue } from '../src/services/axe-accessibility-scanner.service';
import { IssueImpact } from '../src/enums/issue-impact.enum';
import {
  FixtureSiteServer,
  startFixtureSiteServer,
} from './helpers/fixture-site-server';

/**
 * Exercises the real, in-browser `collect` step of the image skill: the DOM
 * candidate query, the axe-aware trigger, size/visibility filtering, and
 * element screenshot capture — all against a live Chromium page. No LLM/network
 * is involved.
 */
describe('ImageAltTextSkill.collect (real browser)', () => {
  jest.setTimeout(60000);

  let fixtureSite: FixtureSiteServer;
  let browserService: BrowserService;
  let browser: Browser;
  let context: BrowserContext;
  const skill = new ImageAltTextSkill();

  const ctx = (overrides: Partial<CollectContext> = {}): CollectContext => ({
    pageUrl: `${fixtureSite.baseUrl}/images.html`,
    axeIssues: [],
    remainingUnits: 100,
    maxUnitsPerPage: 100,
    maxImageBytes: 1_500_000,
    ...overrides,
  });

  const collect = async (
    overrides: Partial<CollectContext> = {},
  ): Promise<ImageEvidence[]> => {
    const page = await context.newPage();
    try {
      await page.goto(`${fixtureSite.baseUrl}/images.html`, {
        waitUntil: 'domcontentloaded',
      });
      return await skill.collect(page, ctx(overrides));
    } finally {
      await page.close();
    }
  };

  beforeAll(async () => {
    fixtureSite = await startFixtureSiteServer(
      join(__dirname, 'fixtures', 'site'),
    );
    browserService = new BrowserService(scanConfig());
    browser = await browserService.getBrowser();
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context.close();
    await browserService.onApplicationShutdown('test teardown');
    await fixtureSite.close();
  });

  it('collects only images with an accessible name, above the size floor', async () => {
    const evidence = await collect();
    const alts = evidence.map((item) => item.alt).sort();

    // 'good' (alt present) and 'decorative' (alt="") survive; 'missing',
    // 'pixel' (too small), and 'hidden' (aria-hidden) are filtered out.
    expect(evidence).toHaveLength(2);
    expect(alts).toEqual(['', 'A solid red square']);
  });

  it('captures an element screenshot for each collected image', async () => {
    const evidence = await collect();
    for (const item of evidence) {
      expect(item.screenshot).toBeInstanceOf(Buffer);
      expect(item.screenshot!.byteLength).toBeGreaterThan(0);
      expect(item.pageUrl).toContain('/images.html');
    }
  });

  it('drops an image already flagged by an axe alt rule', async () => {
    // First discover the good image's src, then feed a matching axe violation.
    const [first] = await collect();
    const axeIssues: ScannedIssue[] = [
      {
        ruleId: 'image-alt',
        description: 'Images must have alternate text',
        impact: IssueImpact.CRITICAL,
        pageUrl: `${fixtureSite.baseUrl}/images.html`,
        context: `<img src="${first.src}">`,
      },
    ];

    const evidence = await collect({ axeIssues });
    expect(evidence.map((item) => item.src)).not.toContain(first.src);
  });
});
