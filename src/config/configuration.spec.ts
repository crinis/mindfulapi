import { agentConfig } from './configuration';
import { ScanMode } from '../enums/scan-mode.enum';

describe('agentConfig allowed scan modes', () => {
  const originalAllowedScanModes = process.env.AGENT_ALLOWED_SCAN_MODES;

  afterEach(() => {
    if (originalAllowedScanModes === undefined) {
      delete process.env.AGENT_ALLOWED_SCAN_MODES;
    } else {
      process.env.AGENT_ALLOWED_SCAN_MODES = originalAllowedScanModes;
    }
  });

  it.each([undefined, '', '   '])('defaults %p to single_url', (configured) => {
    if (configured === undefined) {
      delete process.env.AGENT_ALLOWED_SCAN_MODES;
    } else {
      process.env.AGENT_ALLOWED_SCAN_MODES = configured;
    }

    expect(agentConfig().allowedScanModes).toEqual([ScanMode.SINGLE_URL]);
  });

  it('trims and deduplicates configured scan modes', () => {
    process.env.AGENT_ALLOWED_SCAN_MODES =
      ' crawl, single_url, crawl, url_list ';

    expect(agentConfig().allowedScanModes).toEqual([
      ScanMode.CRAWL,
      ScanMode.SINGLE_URL,
      ScanMode.URL_LIST,
    ]);
  });
});
