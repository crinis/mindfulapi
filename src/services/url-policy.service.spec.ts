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
    pageTimeoutMs: 120_000,
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

    // IPv6 forms that carry an IPv4 address in their low 32 bits: NAT64
    // (64:ff9b::/96) is translated to that IPv4 address by a NAT64 gateway,
    // and the deprecated IPv4-compatible form (::/96) embeds one directly.
    it.each([
      ['NAT64 link-local metadata', 'http://[64:ff9b::a9fe:a9fe]/'],
      ['NAT64 in dotted form', 'http://[64:ff9b::10.0.0.1]/'],
      ['IPv4-compatible loopback', 'http://[::7f00:1]/'],
      ['IPv4-compatible RFC 1918', 'http://[::192.168.1.10]/'],
      ['IPv4-mapped in hex form', 'http://[::ffff:a9fe:a9fe]/'],
    ])('blocks %s (%s)', async (_label, url) => {
      const result = await makeService().isAllowedTarget(url);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private or reserved');
    });

    it('allows NAT64 addresses that embed a public IPv4 address', async () => {
      // 93.184.216.34 — NAT64/DNS64 networks reach IPv4-only sites this way.
      const result = await makeService().isAllowedTarget(
        'http://[64:ff9b::5db8:d822]/',
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

    it('blocks hostnames resolving to a NAT64 address embedding a private IPv4', async () => {
      mockLookup.mockResolvedValue([
        { address: '64:ff9b::a9fe:a9fe', family: 6 },
      ]);
      const result = await makeService().isAllowedTarget(
        'https://evil.example/',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('64:ff9b::a9fe:a9fe');
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

  describe('block codes', () => {
    const dnsError = (code: string) =>
      Object.assign(new Error(`getaddrinfo ${code} host`), { code });

    it.each([
      ['an IP literal', 'http://10.0.0.5/', null],
      ['a private answer', 'https://evil.example/', '10.0.0.8'],
      [
        'a mixed unspecified and private answer',
        'https://evil.example/',
        '0.0.0.0,10.0.0.8',
      ],
      ['the unspecified IP literal', 'http://0.0.0.0/', null],
    ])('marks %s as a private address', async (_label, url, answer) => {
      if (answer) {
        mockLookup.mockResolvedValue(
          answer.split(',').map((address) => ({ address, family: 4 })),
        );
      }
      const result = await makeService().isAllowedTarget(url);
      expect(result).toEqual(
        expect.objectContaining({ allowed: false, code: 'private_address' }),
      );
    });

    it('marks a name that does not exist as unresolvable', async () => {
      mockLookup.mockRejectedValue(dnsError('ENOTFOUND'));
      const result = await makeService().isAllowedTarget(
        'https://nxdomain.invalid/',
      );
      expect(result).toEqual(
        expect.objectContaining({ allowed: false, code: 'unresolvable' }),
      );
      expect(result.reason).toContain('could not be resolved');
    });

    it.each(['EAI_AGAIN', 'EAI_FAIL', 'ETIMEOUT'])(
      'marks a lookup that failed with %s as failed, not as unresolvable',
      async (code) => {
        mockLookup.mockRejectedValue(dnsError(code));
        const result = await makeService().isAllowedTarget(
          'https://flaky.example/',
        );
        expect(result).toEqual(
          expect.objectContaining({ allowed: false, code: 'lookup_failed' }),
        );
        expect(result.reason).toContain(code);
      },
    );

    it.each([
      ['0.0.0.0', 4],
      ['::', 6],
    ])(
      'marks a name answered only with %s (a DNS filter) as a null route',
      async (address, family) => {
        mockLookup.mockResolvedValue([{ address, family }]);
        const result = await makeService().isAllowedTarget(
          'https://tracker.example/',
        );
        expect(result).toEqual(
          expect.objectContaining({ allowed: false, code: 'null_route' }),
        );
      },
    );

    it('marks an unparsable URL as invalid', async () => {
      const result = await makeService().isAllowedTarget('not a url');
      expect(result).toEqual(
        expect.objectContaining({ allowed: false, code: 'invalid_url' }),
      );
    });

    it('gives allowed results no code', async () => {
      const result = await makeService().isAllowedTarget(
        'http://93.184.216.34/',
      );
      expect(result).toEqual({ allowed: true });
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
