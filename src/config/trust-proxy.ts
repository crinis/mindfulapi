import type { NestExpressApplication } from '@nestjs/platform-express';
import { isIP } from 'net';

/**
 * The Express `trust proxy` values MindfulAPI accepts: a safe subset of what
 * Express takes (no functions, no arbitrary strings).
 */
export type TrustProxySetting = boolean | number | string[];

/** Address ranges `proxy-addr` knows by name. */
const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 32;

/** An IP address, an address with a CIDR prefix length, or a preset name. */
function isTrustedAddress(entry: string): boolean {
  if (PRESETS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return (
    /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
  );
}

/**
 * Parses `TRUST_PROXY` into the value for Express's `trust proxy` setting:
 * `true`/`false`, a hop count (1–32), or a comma-separated list of IP
 * addresses, CIDR subnets and the presets `loopback`, `linklocal` and
 * `uniquelocal`.
 *
 * @returns `null` when unset or empty (Express keeps its default: no proxy is
 * trusted).
 * @throws Error naming TRUST_PROXY for any other value; env validation uses
 * this to reject it at startup.
 */
export function parseTrustProxy(
  raw: string | undefined,
): TrustProxySetting | null {
  if (raw === undefined || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops >= 1 && hops <= MAX_HOPS) return hops;
  } else {
    const entries = raw.split(',').map((entry) => entry.trim());
    if (entries.every(isTrustedAddress)) return entries;
  }
  throw new Error(
    `TRUST_PROXY must be true, false, a hop count (1-${MAX_HOPS}), or a comma-separated list of IP addresses, CIDR subnets, loopback, linklocal or uniquelocal (got "${raw}")`,
  );
}

/**
 * Applies a parsed `TRUST_PROXY` to the Express app, so `req.ip` (the client
 * address the rate limiter counts by) comes from `X-Forwarded-For` as far as
 * the trusted proxies reach. Leaves Express's default (trust none) when unset.
 */
export function applyTrustProxy(
  app: NestExpressApplication,
  setting: TrustProxySetting | null,
): void {
  if (setting !== null) {
    app.set('trust proxy', setting);
  }
}
