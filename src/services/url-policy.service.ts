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

/**
 * IPv6 /96 prefixes (as their first six 16-bit groups) whose low 32 bits carry
 * the IPv4 address traffic is delivered to: IPv4-mapped (`::ffff:0:0/96`), the
 * deprecated IPv4-compatible form (`::/96`), and the NAT64 well-known prefix
 * (`64:ff9b::/96`, RFC 6052). Checking the embedded IPv4 address — rather than
 * blocking the whole prefix — keeps public sites reachable from NAT64/DNS64
 * networks while blocking e.g. `64:ff9b::a9fe:a9fe` (169.254.169.254).
 */
const IPV4_EMBEDDING_PREFIXES: ReadonlyArray<readonly number[]> = [
  [0, 0, 0, 0, 0, 0xffff],
  [0, 0, 0, 0, 0, 0],
  [0x64, 0xff9b, 0, 0, 0, 0],
];

/**
 * Expands a valid IPv6 address (compressed and/or with a dotted IPv4 tail)
 * into its eight 16-bit groups, or returns `null` when it cannot be parsed.
 */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const dottedTail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dottedTail) {
    if (isIP(dottedTail[2]) !== 4) return null;
    const [a, b, c, d] = dottedTail[2].split('.').map(Number);
    text = `${dottedTail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<number>(zeros).fill(0), ...tail];

  const valid =
    zeros >= 0 &&
    groups.length === 8 &&
    groups.every(
      (group) => Number.isInteger(group) && group >= 0 && group <= 0xffff,
    );
  return valid ? groups : null;
}

/**
 * Returns the IPv4 address embedded in an IPv4-mapped, IPv4-compatible or
 * NAT64 IPv6 address, or `null` for any other address.
 */
function embeddedIpv4(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return null;
  const embeds = IPV4_EMBEDDING_PREFIXES.some((prefix) =>
    prefix.every((group, index) => groups[index] === group),
  );
  if (!embeds) return null;
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join('.');
}

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

    // IPv6 reserved / special-purpose ranges. IPv4-mapped, IPv4-compatible and
    // NAT64 addresses are additionally checked via their embedded IPv4
    // address (see IPV4_EMBEDDING_PREFIXES).
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
   * Checks one IP address against the block list. IPv6 addresses that embed an
   * IPv4 address (IPv4-mapped, IPv4-compatible, NAT64) are also checked against
   * the IPv4 ranges via that embedded address.
   */
  private checkAddress(
    address: string,
    sourceHost?: string,
  ): TargetPolicyResult {
    const isV6 = isIP(address) === 6;
    const embeddedV4 = isV6 ? embeddedIpv4(address) : null;
    const blocked =
      this.blockList.check(address, isV6 ? 'ipv6' : 'ipv4') ||
      (embeddedV4 !== null && this.blockList.check(embeddedV4, 'ipv4'));

    if (blocked) {
      const via = sourceHost ? ` (resolved from ${sourceHost})` : '';
      return {
        allowed: false,
        reason: `address ${address}${via} is in a private or reserved range`,
      };
    }
    return { allowed: true };
  }
}
