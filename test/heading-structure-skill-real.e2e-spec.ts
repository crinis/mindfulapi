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

  /** Wraps body markup in a page with a title. */
  const doc = (body: string): string =>
    `<!doctype html><html><head><title>Store</title></head><body>${body}</body></html>`;
  const FOLLOWING =
    '<p>We ship to every country in the world within five business days.</p>';

  it('extracts the outline, its content snippets and unheaded sections', async () => {
    const longText = 'Parcels leave our warehouse every weekday. '.repeat(20);
    const evidence = await collectFrom(
      doc(`
        <header><h1>Store</h1></header>
        <main>
          <p>Welcome to the <b>store</b>.</p>
          <script>var ignored = 'script text';</script>
          <h2 aria-hidden="true">Hidden</h2>
          <h2>Delivery</h2>
          <p>Fast delivery.</p>
          <section><p>${longText}</p></section>
        </main>`),
    );

    expect(evidence?.pageTitle).toBe('Store');
    expect(evidence?.headings).toEqual([
      expect.objectContaining({
        id: 'H1',
        level: 1,
        tag: 'h1',
        text: 'Store',
        landmark: 'header',
        // The aria-hidden heading is no heading, but its text is content.
        snippet: 'Welcome to the store. Hidden',
      }),
      expect.objectContaining({
        id: 'H2',
        level: 2,
        text: 'Delivery',
        landmark: 'main',
        snippet: expect.stringMatching(/^Fast delivery\. Parcels leave/),
      }),
    ]);
    expect(evidence?.headings[1].snippet?.length).toBe(120);
    expect(evidence?.unheadedSections).toEqual([
      expect.objectContaining({
        id: 'S1',
        selector: 'html > body > main > section',
      }),
    ]);
  });

  describe('fake-heading candidates', () => {
    it('does not report a styled wrapper around a real heading', async () => {
      const evidence = await collectFrom(
        doc(`
          <main>
            <div style="font-size: 26px"><h3>Shipping</h3></div>
            ${FOLLOWING}
            <p style="font-size: 26px">Returns</p>
            ${FOLLOWING}
          </main>`),
      );

      expect(evidence?.fakeHeadingCandidates.map((c) => c.text)).toEqual([
        'Returns',
      ]);
    });

    it('reports nested styled blocks once, as the innermost block', async () => {
      const evidence = await collectFrom(
        doc(`
          <main>
            <div style="font-size: 24px">
              <p>Our services</p>
              <p>Consulting, engineering and support for teams.</p>
            </div>
            ${FOLLOWING}
          </main>`),
      );

      expect(evidence?.fakeHeadingCandidates.map((c) => c.text)).toEqual([
        'Our services',
      ]);
    });
  });

  describe('open shadow roots', () => {
    /** Defines a custom element rendering `shadow` in an open shadow root. */
    const component = (tag: string, shadow: string): string =>
      `<script>customElements.define('${tag}', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadow)};
        }
      });</script>`;

    it('locates findings inside components by their host in the document', async () => {
      const longText = 'Parcels leave our warehouse every weekday. '.repeat(20);
      const html = doc(`
        ${component('x-inner', '<h3>Deep</h3><p>Nested component text.</p>')}
        ${component(
          'x-card',
          '<h2>Shipping</h2><p>We ship worldwide.</p>' +
            '<h2>Returns</h2><p>Free returns within thirty days.</p>' +
            '<p style="font-size: 26px">Payment</p>' +
            '<p>We accept all major cards and bank transfers.</p>' +
            `<section><p>${longText}</p></section>` +
            '<x-inner></x-inner>',
        )}
        <main>
          <h2>Intro</h2>
          <p>Intro text.</p>
          <x-card></x-card>
        </main>`);
      const page = await context.newPage();
      try {
        await page.setContent(html);
        const [evidence] = await skill.collect(page, ctx());
        const located = [
          ...evidence.headings,
          ...evidence.fakeHeadingCandidates,
          ...evidence.unheadedSections,
        ];
        // What each stored locator points at in the live page.
        const resolved = await page.evaluate(
          (items) =>
            items.map(({ selector, shadowPath }) => {
              const matches = document.querySelectorAll(selector);
              let el: Element | null = matches.length === 1 ? matches[0] : null;
              const host = el?.tagName.toLowerCase() ?? null;
              for (const path of shadowPath ?? []) {
                el = el?.shadowRoot?.querySelector(path) ?? null;
              }
              return {
                host,
                text: el?.firstChild?.textContent?.slice(0, 20) ?? null,
              };
            }),
          located.map(({ selector, shadowPath }) => ({ selector, shadowPath })),
        );

        expect(resolved).toEqual([
          { host: 'h2', text: 'Intro' },
          { host: 'x-card', text: 'Shipping' },
          { host: 'x-card', text: 'Returns' },
          { host: 'x-card', text: 'Deep' },
          { host: 'x-card', text: 'Payment' },
          { host: 'x-card', text: 'Parcels leave our wa' },
        ]);
        expect(evidence.headings[0].shadowPath).toBeUndefined();
      } finally {
        await page.close();
      }
    });

    it('stores inner paths that resolve to the element in its shadow root', async () => {
      // A short path inside the shadow root would match an earlier element:
      // "div > h2" finds Inner before Outer, and a positional chain finds Y
      // (nested the same way) before Target.
      const html = doc(`
        ${component(
          'x-nested',
          '<div><div><h2>Inner</h2></div><h2>Outer</h2></div>',
        )}
        ${component(
          'x-repeat',
          '<div><div><h3>X</h3><h3>Y</h3></div><h3>Target</h3></div>',
        )}
        <main>
          <h1>Store</h1>
          <x-nested></x-nested>
          <x-repeat></x-repeat>
        </main>`);
      const page = await context.newPage();
      try {
        await page.setContent(html);
        const [evidence] = await skill.collect(page, ctx());
        const resolved = await page.evaluate(
          (headings) =>
            headings.map(({ selector, shadowPath }) => {
              let el: Element | null = document.querySelector(selector);
              for (const path of shadowPath ?? []) {
                el = el?.shadowRoot?.querySelector(path) ?? null;
              }
              return el?.textContent ?? null;
            }),
          evidence.headings.map(({ selector, shadowPath }) => ({
            selector,
            shadowPath,
          })),
        );

        expect(evidence.headings.map((heading) => heading.text)).toEqual([
          'Store',
          'Inner',
          'Outer',
          'X',
          'Y',
          'Target',
        ]);
        expect(resolved).toEqual([
          'Store',
          'Inner',
          'Outer',
          'X',
          'Y',
          'Target',
        ]);
      } finally {
        await page.close();
      }
    });

    it('lists headings inside components in reading order', async () => {
      const evidence = await collectFrom(
        doc(`
          ${component('x-card', '<h2>Shipping</h2><p>We ship worldwide within five days.</p>')}
          ${component('x-panel', '<h2>Panel</h2><slot></slot>')}
          <main>
            <h1>Store</h1>
            <p>Welcome to the store.</p>
            <x-card></x-card>
            <x-panel><h3>Slotted</h3><p>Slotted content.</p></x-panel>
            <h2>Contact</h2>
          </main>`),
      );

      expect(evidence?.headings.map((h) => h.text)).toEqual([
        'Store',
        'Shipping',
        'Panel',
        'Slotted',
        'Contact',
      ]);
      expect(evidence?.headings.map((h) => h.id)).toEqual([
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
      ]);
      expect(evidence?.headings[0].snippet).toBe('Welcome to the store.');
      expect(evidence?.headings[1].snippet).toBe(
        'We ship worldwide within five days.',
      );
      expect(evidence?.headings[3].snippet).toBe('Slotted content.');
    });

    it('does not list a section whose heading is inside a component', async () => {
      const evidence = await collectFrom(
        doc(`
          ${component('x-title', '<h2>Delivery</h2>')}
          <main>
            <h1>Store</h1>
            <section>
              <x-title></x-title>
              <p>${'Parcels leave our warehouse every weekday. '.repeat(20)}</p>
            </section>
          </main>`),
      );

      expect(evidence?.headings.map((h) => h.text)).toEqual([
        'Store',
        'Delivery',
      ]);
      expect(evidence?.unheadedSections).toEqual([]);
    });
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
