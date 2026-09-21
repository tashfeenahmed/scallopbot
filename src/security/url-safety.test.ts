import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const { checkUrlIsPublic, isPrivateIpAddress, safeFetch, BlockedUrlError } = await import('./url-safety.js');

describe('isPrivateIpAddress', () => {
  it('flags loopback, private, link-local and reserved IPv4', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateIpAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.167.1.1']) {
      expect(isPrivateIpAddress(address), address).toBe(false);
    }
  });

  it('flags IPv6 loopback, unique-local, link-local and IPv4-mapped loopback', () => {
    for (const address of ['::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isPrivateIpAddress(address), address).toBe(true);
    }
    expect(isPrivateIpAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('flags loopback and private targets written in hex or expanded form', () => {
    // Every one of these is 127.0.0.1, 192.168.1.1 or 169.254.169.254 wearing
    // a different IPv6 spelling. A text-prefix check misses all of them:
    // '::ffff:7f00:1' shares no prefix with '::1', 'fc', 'fe80' or 'ff'.
    for (const address of [
      '0:0:0:0:0:0:0:1',      // loopback, fully expanded
      '::ffff:7f00:1',        // IPv4-mapped loopback in hex
      '::ffff:c0a8:101',      // IPv4-mapped 192.168.1.1
      '::ffff:a9fe:a9fe',     // IPv4-mapped cloud metadata
      '::7f00:1',             // IPv4-compatible loopback
      '64:ff9b::7f00:1',      // NAT64-wrapped loopback
      '2002:7f00:1::',        // 6to4-wrapped loopback
      '0064:ff9b:0000:0000:0000:0000:7f00:0001',
    ]) {
      expect(isPrivateIpAddress(address), address).toBe(true);
    }
  });

  it('still allows public IPv6, including a 6to4 wrapper around a public v4', () => {
    for (const address of [
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:93.184.216.34',
      '::ffff:5db8:d822',     // IPv4-mapped 93.184.216.34 in hex
      '2002:5db8:d822::',     // 6to4 around a public v4
    ]) {
      expect(isPrivateIpAddress(address), address).toBe(false);
    }
  });

  it('fails closed on malformed IPv6-looking input', () => {
    for (const address of ['1:2:3', 'gggg::1', '::1::2', 'not-an-ip']) {
      expect(isPrivateIpAddress(address), address).toBe(true);
    }
  });
});

describe('checkUrlIsPublic', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('rejects non-http protocols', async () => {
    expect(await checkUrlIsPublic('ftp://example.com')).toMatchObject({ safe: false });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects loopback literals without a DNS lookup', async () => {
    expect(await checkUrlIsPublic('http://127.0.0.1:3000/api/files')).toMatchObject({ safe: false });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a decimal-encoded loopback address', async () => {
    // 2130706433 === 127.0.0.1; the old regex allow-list never matched this.
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await checkUrlIsPublic('http://2130706433/')).toMatchObject({ safe: false });
  });

  it('rejects a bracketed IPv6 literal that spells loopback in hex', async () => {
    expect(await checkUrlIsPublic('http://[::ffff:7f00:1]:3000/api/files?path=.env'))
      .toMatchObject({ safe: false });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
    expect(await checkUrlIsPublic('http://intranet.example.com/')).toMatchObject({ safe: false });
  });

  it('allows a hostname that resolves publicly', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await checkUrlIsPublic('https://example.com/page')).toEqual({ safe: true });
  });
});

describe('safeFetch', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks a redirect from a public host to loopback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'http://127.0.0.1:3000/api/costs' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://example.com/redirect')).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect between public hosts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 301, headers: new Headers({ location: 'https://example.org/final' }) })
      .mockResolvedValueOnce({ status: 200, headers: new Headers() });
    vi.stubGlobal('fetch', fetchMock);

    const response = await safeFetch('https://example.com/start');
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.org/final');
  });

  it('gives up after too many redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'https://example.com/loop' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://example.com/loop', {}, { maxRedirects: 2 }))
      .rejects.toThrow(/Too many redirects/);
  });
});
