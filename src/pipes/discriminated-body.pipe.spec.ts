import 'reflect-metadata';
import { DiscriminatedBodyPipe } from './discriminated-body.pipe';
import { ScanMode } from '../enums/scan-mode.enum';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';
import { ValidationProblemException } from '../exceptions/validation-problem.exception';
import {
  CreateCrawlScanDto,
  CreateSingleUrlScanDto,
} from '../dto/scan/request';

describe('DiscriminatedBodyPipe', () => {
  let pipe: DiscriminatedBodyPipe;

  beforeEach(() => {
    pipe = new DiscriminatedBodyPipe();
  });

  it('accepts a valid single_url payload and returns a typed instance', async () => {
    const result = await pipe.transform({
      mode: ScanMode.SINGLE_URL,
      url: 'https://example.com',
    });
    expect(result).toBeInstanceOf(CreateSingleUrlScanDto);
    expect(result.mode).toBe(ScanMode.SINGLE_URL);
  });

  it('accepts an AI audit without a skill list', async () => {
    const result = (await pipe.transform({
      mode: ScanMode.SINGLE_URL,
      url: 'https://example.com',
      aiAudit: {},
    })) as CreateSingleUrlScanDto;
    expect(result.aiAudit).toBeDefined();
    expect(result.aiAudit?.skills).toBeUndefined();
  });

  it('rejects an explicitly empty AI skill list', async () => {
    await expect(
      pipe.transform({
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        aiAudit: { skills: [] },
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('rejects a null AI skill list instead of enabling every skill', async () => {
    await expect(
      pipe.transform({
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        aiAudit: { skills: null },
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('rejects a null AI-audit object', async () => {
    await expect(
      pipe.transform({
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        aiAudit: null,
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('rejects an unknown AI skill instead of falling back to all skills', async () => {
    await expect(
      pipe.transform({
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        aiAudit: { skills: ['imag_alt_text'] },
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('accepts a valid crawl payload with nested crawlOptions', async () => {
    const result = (await pipe.transform({
      mode: ScanMode.CRAWL,
      startUrls: ['https://example.com'],
      crawlOptions: { maxPages: 20, strategy: CrawlStrategy.SameDomain },
    })) as CreateCrawlScanDto;
    expect(result).toBeInstanceOf(CreateCrawlScanDto);
    expect(result.crawlOptions?.strategy).toBe(CrawlStrategy.SameDomain);
  });

  it('rejects an unknown mode', async () => {
    await expect(pipe.transform({ mode: 'nope' })).rejects.toThrow(
      ValidationProblemException,
    );
  });

  it('rejects a missing mode', async () => {
    await expect(pipe.transform({})).rejects.toThrow(
      ValidationProblemException,
    );
  });

  it('rejects fields belonging to another mode (cross-field)', async () => {
    // crawlOptions is not allowed on a single_url payload.
    await expect(
      pipe.transform({
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        crawlOptions: { maxPages: 20 },
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('rejects an invalid URL with a field-level pointer', async () => {
    try {
      await pipe.transform({ mode: ScanMode.SINGLE_URL, url: 'not-a-url' });
      fail('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationProblemException);
      const problem = error as ValidationProblemException;
      expect(problem.fieldErrors.some((e) => e.pointer === '/url')).toBe(true);
    }
  });

  it('rejects a url_list with fewer than two entries', async () => {
    await expect(
      pipe.transform({
        mode: ScanMode.URL_LIST,
        urls: ['https://example.com'],
      }),
    ).rejects.toThrow(ValidationProblemException);
  });

  it('rejects a url_list exceeding the maximum size', async () => {
    const urls = Array.from(
      { length: 501 },
      (_unused, i) => `https://example.com/${i}`,
    );
    await expect(
      pipe.transform({ mode: ScanMode.URL_LIST, urls }),
    ).rejects.toThrow(ValidationProblemException);
  });
});
