import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it.each([undefined, ''])('treats %p as unset', (raw) => {
    expect(parseTrustProxy(raw)).toBeNull();
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['2', 2],
    ['32', 32],
    ['loopback', ['loopback']],
    ['10.0.0.1', ['10.0.0.1']],
    ['172.16.0.0/12', ['172.16.0.0/12']],
    ['fd00::/8', ['fd00::/8']],
    [' loopback , 172.18.0.0/16,::1 ', ['loopback', '172.18.0.0/16', '::1']],
    ['linklocal,uniquelocal', ['linklocal', 'uniquelocal']],
  ])('parses %p', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it.each([
    'yes',
    'TRUE',
    '0',
    '33',
    '-1',
    '1.5',
    '0x1',
    'proxy.example.com',
    '10.0.0.0/33',
    '::1/129',
    '10.0.0.1/',
    '10.0.0.0/8/8',
    '10.0.0.0/255.0.0.0',
    'loopback,',
    'loopback,,10.0.0.1',
    '*',
  ])('rejects %p', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
  });
});
