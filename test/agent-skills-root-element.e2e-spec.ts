import type { Browser, BrowserContext, Page } from 'playwright';
import { BrowserService } from '../src/services/browser.service';
import { scanConfig } from '../src/config/configuration';
import { ImageAltTextSkill } from '../src/agent/skills/image-alt-text.skill';
import { HeadingStructureSkill } from '../src/agent/skills/heading-structure.skill';
import { LinkPurposeSkill } from '../src/agent/skills/link-purpose.skill';
import { FormLabelsSkill } from '../src/agent/skills/form-labels.skill';
import { PageTitleSkill } from '../src/agent/skills/page-title.skill';
import type { CollectContext } from '../src/agent/skills/audit-skill.interface';

/**
 * A scan limited to `scanOptions.rootElement` audits (and pays for) only that
 * region with axe; the AI skills must stay inside it too. Real Chromium, no
 * LLM/network.
 */
describe('AI skills and scanOptions.rootElement (real browser)', () => {
  jest.setTimeout(60000);

  let browserService: BrowserService;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const SITE_CHROME = (region: string) => `
    <img alt="${region} logo" width="80" height="80" src="${PNG}">
    <h2>${region} heading</h2>
    <p><a href="/${region}">${region} link</a></p>
    <label for="${region}-q">${region} field</label><input id="${region}-q">`;

  const ctx = (rootElement?: string): CollectContext => ({
    pageUrl: 'https://example.com/',
    axeIssues: [],
    remainingUnits: 100,
    maxUnitsPerPage: 100,
    maxImageBytes: 1_500_000,
    rootElement,
  });

  beforeAll(async () => {
    browserService = new BrowserService(scanConfig());
    browser = await browserService.getBrowser();
    context = await browser.newContext();
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><title>Store</title></head><body>
      <header>${SITE_CHROME('header')}</header>
      <main><h1>Products</h1>${SITE_CHROME('main')}</main>
      <aside class="extra">${SITE_CHROME('aside')}</aside>
      <footer>${SITE_CHROME('footer')}</footer>
    </body></html>`);
  });

  afterAll(async () => {
    await context.close();
    await browserService.onApplicationShutdown('test teardown');
  });

  it('collects images only inside the root element', async () => {
    const evidence = await new ImageAltTextSkill().collect(page, ctx('main'));
    expect(evidence.map((item) => item.alt)).toEqual(['main logo']);
  });

  it('collects every match of the root selector, like axe', async () => {
    const evidence = await new ImageAltTextSkill().collect(
      page,
      ctx('main, .extra'),
    );
    expect(evidence.map((item) => item.alt)).toEqual([
      'main logo',
      'aside logo',
    ]);
  });

  it('outlines headings only inside the root element', async () => {
    const [evidence] = await new HeadingStructureSkill().collect(
      page,
      ctx('main'),
    );
    expect(evidence.headings.map((heading) => heading.text)).toEqual([
      'Products',
      'main heading',
    ]);
  });

  it('lists links only inside the root element', async () => {
    const [evidence] = await new LinkPurposeSkill().collect(page, ctx('main'));
    expect(evidence.links.map((link) => link.text)).toEqual(['main link']);
  });

  it('lists form fields only inside the root element', async () => {
    const [evidence] = await new FormLabelsSkill().collect(page, ctx('main'));
    expect(evidence.fields.map((field) => field.name)).toEqual(['main field']);
  });

  it('keeps judging the page title page-wide', async () => {
    const [evidence] = await new PageTitleSkill().collect(page, ctx('main'));
    expect(evidence.title).toBe('Store');
  });

  it('collects the whole page without a root element', async () => {
    const evidence = await new ImageAltTextSkill().collect(page, ctx());
    expect(evidence).toHaveLength(4);
  });
});
