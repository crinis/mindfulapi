import type { Browser, BrowserContext } from 'playwright';
import { BrowserService } from '../src/services/browser.service';
import { scanConfig } from '../src/config/configuration';
import {
  HeadingStructureSkill,
  type HeadingEvidence,
} from '../src/agent/skills/heading-structure.skill';
import type { CollectContext } from '../src/agent/skills/audit-skill.interface';

/**
 * Exercises the real, in-browser extraction of the heading skill — the
 * outline, styled fake-heading candidates and unheaded sections — against a
 * live Chromium page. No LLM/network is involved.
 */
describe('HeadingStructureSkill.collect (real browser)', () => {
  jest.setTimeout(60000);

  let browserService: BrowserService;
  let browser: Browser;
  let context: BrowserContext;
  const skill = new HeadingStructureSkill();

  const ctx = (overrides: Partial<CollectContext> = {}): CollectContext => ({
    pageUrl: 'https://example.com/',
    axeIssues: [],
    remainingUnits: 100,
    maxUnitsPerPage: 100,
    maxImageBytes: 1_500_000,
    ...overrides,
  });

  /** Extracts the heading evidence of inline markup. */
  const collectFrom = async (
    html: string,
    overrides: Partial<CollectContext> = {},
  ): Promise<HeadingEvidence | undefined> => {
    const page = await context.newPage();
    try {
      await page.setContent(html);
      const [evidence] = await skill.collect(page, ctx(overrides));
      return evidence;
    } finally {
      await page.close();
    }
  };

  beforeAll(async () => {
    browserService = new BrowserService(scanConfig());
    browser = await browserService.getBrowser();
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context.close();
    await browserService.onApplicationShutdown('test teardown');
  });

  it('caps the page-controlled text sent to the model', async () => {
    const long = 'x'.repeat(5000);
    const evidence = await collectFrom(
      `<!doctype html><html><head><title>${long}</title></head>
      <body><main><h1>${long}</h1><p>Some content.</p></main></body></html>`,
    );

    expect(evidence?.pageTitle.length).toBeLessThanOrEqual(200);
    expect(evidence?.headings[0].text.length).toBeLessThanOrEqual(120);
  });
});
