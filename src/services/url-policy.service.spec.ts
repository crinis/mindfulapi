const mockLookup = jest.fn();

jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { BadRequestException } from '@nestjs/common';
import { UrlPolicyService } from './url-policy.service';
import { scanConfig } from '../config/configuration';
import { ConfigType } from '@nestjs/config';

function makeService(
  overrides: Partial<ConfigType<typeof scanConfig>> = {},
): UrlPolicyService {
  return new UrlPolicyService({
    crawlConcurrency: 4,
    scanConcurrency: 1,
    allowPrivateTargets: false,
    targetAllowHosts: [],
    playwrightWsUrl: null,
    ignoreHttpsErrors: false,
    ...overrides,
  });
}

describe('UrlPolicyService', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  describe('IP literal targets', () => {
    it.each([
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.1.1/',
      'http://192.168.1.10/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
    ])('blocks %s', async (url) => {
      const result = await makeService().isAllowedTarget(url);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private or reserved');
    });

    it('allows public IPv4 literals', async () => {
      const result = await makeService().isAllowedTarget(
        'http://93.184.216.34/',
      );
      expect(result.allowed).toBe(true);
    });

    it('allows public IPv6 literals', async () => {
      const result = await makeService().isAllowedTarget(
        'http://[2606:2800:220:1:248:1893:25c8:1946]/',
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('hostname targets', () => {
    it('allows hostnames resolving to public addresses only', async () => {
      mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const result = await makeService().isAllowedTarget(
        'https://example.com/',
      );
      expect(result.allowed).toBe(true);
      expect(mockLookup).toHaveBeenCalledWith('example.com', {
        all: true,
        verbatim: true,
      });
    });

    it('blocks hostnames resolving to a private address', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]);
      const result = await makeService().isAllowedTarget(
        'https://evil.example/',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('10.0.0.8');
    });

    it('blocks hostnames resolving to an IPv4-mapped loopback', async () => {
      mockLookup.mockResolvedValue([
        { address: '::ffff:127.0.0.1', family: 6 },
      ]);
      const result = await makeService().isAllowedTarget(
        'https://evil.example/',
      );
      expect(result.allowed).toBe(false);
    });

    it('blocks unresolvable hostnames', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      const result = await makeService().isAllowedTarget(
        'https://does-not-exist.example/',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('could not be resolved');
    });
  });

  describe('configuration overrides', () => {
    it('allows everything when allowPrivateTargets is true', async () => {
      const service = makeService({ allowPrivateTargets: true });
      const result = await service.isAllowedTarget(
        'http://169.254.169.254/latest/meta-data/',
      );
      expect(result.allowed).toBe(true);
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('allows allowlisted hosts without DNS resolution', async () => {
      const service = makeService({ targetAllowHosts: ['staging.internal'] });
      const result = await service.isAllowedTarget('https://staging.internal/');
      expect(result.allowed).toBe(true);
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('matches allowlisted hosts case-insensitively', async () => {
      const service = makeService({ targetAllowHosts: ['Staging.Internal'] });
      const result = await service.isAllowedTarget('https://STAGING.internal/');
      expect(result.allowed).toBe(true);
    });

    it('still blocks non-allowlisted private hosts', async () => {
      const service = makeService({ targetAllowHosts: ['staging.internal'] });
      const result = await service.isAllowedTarget('http://192.168.0.1/');
      expect(result.allowed).toBe(false);
    });
  });

  describe('assertAllowedTargets', () => {
    it('passes when all targets are allowed', async () => {
      mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        makeService().assertAllowedTargets([
          'https://example.com/',
          'https://example.com/about',
        ]),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException listing every blocked target', async () => {
      await expect(
        makeService().assertAllowedTargets([
          'http://127.0.0.1/',
          'http://192.168.1.1/',
        ]),
      ).rejects.toThrow(BadRequestException);

      try {
        await makeService().assertAllowedTargets([
          'http://127.0.0.1/',
          'http://192.168.1.1/',
        ]);
      } catch (error) {
        const message = (error as BadRequestException).message;
        expect(message).toContain('http://127.0.0.1/');
        expect(message).toContain('http://192.168.1.1/');
      }
    });
  });
});
