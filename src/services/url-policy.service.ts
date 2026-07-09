import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { scanConfig } from '../config/configuration';

/** Outcome of a target policy check. */
export interface TargetPolicyResult {
  /** Whether the URL may be fetched by the scanner. */
  allowed: boolean;
  /** Human-readable reason when the URL is blocked. */
  reason?: string;
}

/**
 * Guards the scanner against server-side request forgery (SSRF).
 *
 * Scan targets are user-supplied URLs that the server-side browser navigates
 * to, so without a policy any API client could make the server fetch cloud
 * metadata endpoints or internal services. This service blocks targets whose
 * host is (or resolves to) a reserved/private address.
 *
 * Operators scanning intranet sites can opt out globally via
 * `SCAN_ALLOW_PRIVATE_TARGETS=true` or per-host via `SCAN_TARGET_ALLOW_HOSTS`.
 *
 * Known limitation (documented in the README): addresses are resolved before
 * navigation, so a DNS-rebinding attack with a very low TTL could still flip
 * the record between check and fetch. Full mitigation requires per-request IP
 * pinning inside the browser, which is disproportionate for a self-hosted
 * tool.
 */
@Injectable()
export class UrlPolicyService {
  private readonly logger = new Logger(UrlPolicyService.name);
  /** Reserved/special-purpose ranges that scan targets must not resolve to. */
  private readonly blockList = new BlockList();

  /**
   * @param config Scan namespace configuration (bypass flag, host allowlist).
   */
  constructor(
    @Inject(scanConfig.KEY)
    private readonly config: ConfigType<typeof scanConfig>,
  ) {
    // IPv4 reserved / special-purpose ranges.
    this.blockList.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
    this.blockList.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC 1918
    this.blockList.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
    this.blockList.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
    this.blockList.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local / metadata
    this.blockList.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC 1918
    this.blockList.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol
    this.blockList.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
    this.blockList.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC 1918
    this.blockList.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
    this.blockList.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
    this.blockList.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
    this.blockList.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
    this.blockList.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + broadcast

    // IPv6 reserved / special-purpose ranges.
    this.blockList.addSubnet('::', 128, 'ipv6'); // unspecified
    this.blockList.addSubnet('::1', 128, 'ipv6'); // loopback
    this.blockList.addSubnet('fc00::', 7, 'ipv6'); // unique local
    this.blockList.addSubnet('fe80::', 10, 'ipv6'); // link-local
    this.blockList.addSubnet('ff00::', 8, 'ipv6'); // multicast
  }

  /**
   * Checks whether a URL may be fetched by the scanner.
   *
   * Hostnames are resolved via DNS and every returned address must be
   * publicly routable; IP literals are checked directly.
   *
   * @param url Absolute HTTP(S) URL to check.
   */
  async isAllowedTarget(url: string): Promise<TargetPolicyResult> {
    if (this.config.allowPrivateTargets) {
      return { allowed: true };
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { allowed: false, reason: 'invalid URL' };
    }

    // URL wraps IPv6 literals in brackets.
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (
      this.config.targetAllowHosts.some(
        (allowed) => allowed.toLowerCase() === host,
      )
    ) {
      return { allowed: true };
    }

    if (isIP(host)) {
      return this.checkAddress(host);
    }

    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return {
        allowed: false,
        reason: `hostname ${host} could not be resolved`,
      };
    }

    for (const { address } of addresses) {
      const result = this.checkAddress(address, host);
      if (!result.allowed) {
        return result;
      }
    }

    return { allowed: true };
  }

  /**
   * Validates a set of scan targets, rejecting the request when any target
   * violates the policy.
   *
   * @param urls Normalized absolute target URLs.
   * @throws BadRequestException Listing every blocked URL with its reason.
   */
  async assertAllowedTargets(urls: string[]): Promise<void> {
    const results = await Promise.all(
      urls.map(async (url) => ({
        url,
        result: await this.isAllowedTarget(url),
      })),
    );

    const blocked = results.filter(({ result }) => !result.allowed);
    if (blocked.length === 0) {
      return;
    }

    const details = blocked
      .map(({ url, result }) => `${url} (${result.reason ?? 'blocked'})`)
      .join(', ');
    throw new BadRequestException(
      `Scan target(s) not allowed: ${details}. Private and reserved network targets are blocked; ` +
        'set SCAN_ALLOW_PRIVATE_TARGETS=true or add the host to SCAN_TARGET_ALLOW_HOSTS to permit them.',
    );
  }

  /**
   * Checks one IP address (v4, v6, or IPv4-mapped v6) against the block list.
   */
  private checkAddress(
    address: string,
    sourceHost?: string,
  ): TargetPolicyResult {
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d) so the IPv4 ranges apply.
    const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    const candidate = mappedV4 ?? address;
    const family = isIP(candidate) === 6 ? 'ipv6' : 'ipv4';

    if (this.blockList.check(candidate, family)) {
      const via = sourceHost ? ` (resolved from ${sourceHost})` : '';
      return {
        allowed: false,
        reason: `address ${address}${via} is in a private or reserved range`,
      };
    }
    return { allowed: true };
  }
}
