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

  /** A 1x1 PNG, rendered at whatever size the markup asks for. */
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** Collects from inline markup instead of the fixture site. */
  const collectFrom = async (
    body: string,
    overrides: Partial<CollectContext> = {},
  ): Promise<{ evidence: ImageEvidence[]; altAt: (string | null)[] }> => {
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
      const evidence = await skill.collect(page, ctx(overrides));
      // What each stored selector points at once the audit attributes are gone.
      const altAt = await page.evaluate(
        (selectors) => {
          document
            .querySelectorAll('[data-mfa-audit-id]')
            .forEach((el) => el.removeAttribute('data-mfa-audit-id'));
          return selectors.map((selector) => {
            if (selector === null) return null;
            const matches = document.querySelectorAll(selector);
            return matches.length === 1 ? matches[0].getAttribute('alt') : null;
          });
        },
        evidence.map((item) => item.selector ?? null),
      );
      return { evidence, altAt };
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

  it('stores a CSS selector that locates the image in the page', async () => {
    const { evidence, altAt } = await collectFrom(`
      <main>
        <figure><img alt="Sales chart" width="80" height="80" src="${PNG}"></figure>
        <p><img alt="Company logo" width="80" height="80" src="${PNG}"></p>
        <p><img alt="Team photo" width="80" height="80" src="${PNG}"></p>
      </main>`);

    expect(evidence.map((item) => item.alt)).toEqual([
      'Sales chart',
      'Company logo',
      'Team photo',
    ]);
    expect(altAt).toEqual(['Sales chart', 'Company logo', 'Team photo']);
  });

  it('stores a selector that matches only its image in a card grid', async () => {
    // Every image ends in the same five steps (div > div > a > picture > img).
    const card = (alt: string): string => `
      <li><div><div><a href="#"><picture>
        <img alt="${alt}" width="80" height="80" src="${PNG}">
      </picture></a></div></div></li>`;
    const { evidence, altAt } = await collectFrom(`
      <main><ul>${card('Red shoe')}${card('Blue shoe')}${card('Green shoe')}</ul></main>`);

    expect(altAt).toEqual(['Red shoe', 'Blue shoe', 'Green shoe']);
    expect(new Set(evidence.map((item) => item.selector)).size).toBe(3);
  });

  it('stores a positional selector when duplicate ids leave no unique path', async () => {
    const { altAt } = await collectFrom(`
      <div id="card"><img alt="First" width="80" height="80" src="${PNG}"></div>
      <div id="card"><img alt="Second" width="80" height="80" src="${PNG}"></div>`);

    expect(altAt).toEqual(['First', 'Second']);
  });

  it('grows a selector one step at a time until it matches only its image', async () => {
    // Deep in the page, under 250 nested divs: the full path to the root is
    // far longer than a stored selector may be, and six steps suffice.
    const card = (alt: string): string => `
      <li><div><div><a href="#"><picture>
        <img alt="${alt}" width="80" height="80" src="${PNG}">
      </picture></a></div></div></li>`;
    const { evidence, altAt } = await collectFrom(
      `${'<div>'.repeat(250)}<ul>${card('Red shoe')}${card('Blue shoe')}</ul>${'</div>'.repeat(250)}`,
    );

    expect(altAt).toEqual(['Red shoe', 'Blue shoe']);
    expect(evidence.map((item) => item.selector)).toEqual([
      'li:nth-of-type(1) > div > div > a > picture > img',
      'li:nth-of-type(2) > div > div > a > picture > img',
    ]);
  });

  it('stores no selector when only a path longer than the stored cap is unique', async () => {
    // Two identical branches 300 divs deep: only the step where they part
    // tells the images apart, more than 1000 characters up.
    const branch = (alt: string): string =>
      `<section>${'<div>'.repeat(300)}<img alt="${alt}" width="80" height="80" src="${PNG}">${'</div>'.repeat(300)}</section>`;
    const { evidence } = await collectFrom(branch('Left') + branch('Right'));

    expect(evidence.map((item) => item.alt)).toEqual(['Left', 'Right']);
    expect(evidence.map((item) => item.selector)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('caps the page-controlled text sent to the model and stored', async () => {
    const long = 'x'.repeat(5000);
    const { evidence } = await collectFrom(`
      <span id="label">${long}</span>
      <figure>
        <img alt="${long}" aria-label="${long}" aria-labelledby="label"
          title="${long}" width="80" height="80"
          src="data:image/png;base64,${'A'.repeat(5000)}">
        <figcaption>${long}</figcaption>
      </figure>`);

    expect(evidence).toHaveLength(1);
    const [image] = evidence;
    const fields = [
      image.alt,
      image.ariaLabel,
      image.ariaLabelledbyText,
      image.title,
      image.figcaption,
    ];
    // Cut to 300 characters, the last one an ellipsis marking the cut.
    expect(fields.map((value) => value?.length)).toEqual([
      300, 300, 300, 300, 300,
    ]);
    expect(fields.every((value) => value?.endsWith('x…'))).toBe(true);
    expect(image.src?.length).toBe(500);
  });

  it('skips hidden images and captures animated ones without waiting', async () => {
    const started = Date.now();
    const { evidence } = await collectFrom(`
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      <div style="content-visibility: hidden">
        <img alt="Collapsed" width="80" height="80" src="${PNG}">
      </div>
      <img alt="Spinner" width="80" height="80" src="${PNG}"
        style="animation: spin 1s linear infinite">`);

    expect(evidence.map((item) => item.alt)).toEqual(['Spinner']);
    expect(evidence[0].screenshot).toBeInstanceOf(Buffer);
    // Either image used to cost the full 5 s screenshot timeout.
    expect(Date.now() - started).toBeLessThan(3000);
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
