import { redactUrlPath } from './redact-url-path.util';

const SECRET = '0123456789abcdef0123456789abcdef';
const URL_WITH_PATH = `ws://playwright:3000/${SECRET}`;

describe('redactUrlPath', () => {
  it('replaces the path of a URL with /<redacted>', () => {
    expect(redactUrlPath(URL_WITH_PATH, URL_WITH_PATH)).toBe(
      'ws://playwright:3000/<redacted>',
    );
  });

  it('keeps a URL without a path as it is', () => {
    expect(redactUrlPath('ws://playwright:3000', 'ws://playwright:3000')).toBe(
      'ws://playwright:3000',
    );
    expect(
      redactUrlPath('ws://playwright:3000/', 'ws://playwright:3000/'),
    ).toBe('ws://playwright:3000/');
  });

  it('removes every occurrence of the path from a Playwright connect error', () => {
    // The shape chromium.connect rejects with (Playwright 1.60): the call log
    // repeats the endpoint, query string stripped, path kept.
    const message =
      'browserType.connect: WebSocket error: connect ECONNREFUSED 172.18.0.3:3000\n' +
      'Call log:\n' +
      `\u001b[2m  - <ws connecting> ws://playwright:3000/${SECRET}\u001b[22m\n` +
      `\u001b[2m  - <ws error> ws://playwright:3000/${SECRET} error connect ECONNREFUSED 172.18.0.3:3000\u001b[22m\n` +
      `\u001b[2m  - <ws disconnected> ws://playwright:3000/${SECRET} code=1006 reason=\u001b[22m\n`;

    const redacted = redactUrlPath(message, `${URL_WITH_PATH}?browser=x`);

    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain(
      '<ws connecting> ws://playwright:3000/<redacted>',
    );
    expect(redacted).toContain('connect ECONNREFUSED 172.18.0.3:3000');
  });

  it('also removes a path that URL parsing normalizes', () => {
    const url = 'ws://playwright:3000/a b';
    expect(redactUrlPath('raw /a b and parsed /a%20b', url)).toBe(
      'raw /<redacted> and parsed /<redacted>',
    );
  });

  it('leaves the text alone when the URL cannot be parsed', () => {
    expect(redactUrlPath('some error', 'not a url')).toBe('some error');
  });
});
