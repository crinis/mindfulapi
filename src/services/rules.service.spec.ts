import { Test, TestingModule } from '@nestjs/testing';
import { RulesService } from './rules.service';

describe('RulesService', () => {
  let service: RulesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RulesService],
    }).compile();

    service = module.get<RulesService>(RulesService);
  });

  it('returns an array', () => {
    expect(Array.isArray(service.getRules())).toBe(true);
  });

  it('returns more than 100 rules', () => {
    expect(service.getRules().length).toBeGreaterThan(100);
  });

  it('returns rules sorted alphabetically by id', () => {
    const ids = service.getRules().map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('each rule has id, description, helpUrl, tags', () => {
    for (const rule of service.getRules()) {
      expect(typeof rule.id).toBe('string');
      expect(typeof rule.description).toBe('string');
      expect(
        rule.helpUrl === undefined || typeof rule.helpUrl === 'string',
      ).toBe(true);
      expect(Array.isArray(rule.tags)).toBe(true);
    }
  });

  it('does not include removed fields (impact, urls)', () => {
    for (const rule of service.getRules()) {
      expect(rule).not.toHaveProperty('impact');
      expect(rule).not.toHaveProperty('urls');
    }
  });

  it('helpUrls point to dequeuniversity.com when present', () => {
    for (const rule of service.getRules()) {
      if (rule.helpUrl) {
        expect(rule.helpUrl).toContain('dequeuniversity.com');
      }
    }
  });

  it('contains well-known axe rules', () => {
    const ids = service.getRules().map((r) => r.id);
    expect(ids).toContain('color-contrast');
    expect(ids).toContain('image-alt');
    expect(ids).toContain('label');
    expect(ids).toContain('landmark-one-main');
  });

  it('returns the same result on repeated calls (stable/idempotent)', () => {
    const first = service.getRules().map((r) => r.id);
    const second = service.getRules().map((r) => r.id);
    expect(first).toEqual(second);
  });
});
