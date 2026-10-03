const mockLaunch = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
    connect: jest.fn(),
  },
}));

import { EventEmitter } from 'node:events';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ScanProcessor } from './scan.processor';
import { BrowserService } from './browser.service';
import { AxeAccessibilityScanner } from './axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import { AgentAuditService } from '../agent/agent-audit.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { scanConfig } from '../config/configuration';

/**
 * Graceful shutdown must stop the BullMQ worker — letting the active scan
 * finish — before the shared browser closes. The worker would otherwise be
 * closed by BullModule's onApplicationShutdown, which Nest runs after
 * BrowserService's (QueueModule is closer to the root module), so an active
 * scan saw its pages close and completed with bogus failures.
 */
describe('Shutdown order', () => {
  let moduleRef: TestingModule;
  const events: string[] = [];

  beforeEach(async () => {
    events.length = 0;
    const browser = Object.assign(new EventEmitter(), {
      isConnected: () => true,
      close: () => {
        events.push('browser closed');
        return Promise.resolve();
      },
    });
    mockLaunch.mockResolvedValue(browser);

    moduleRef = await Test.createTestingModule({
      providers: [
        ScanProcessor,
        BrowserService,
        { provide: getRepositoryToken(Scan), useValue: {} },
        { provide: getRepositoryToken(Issue), useValue: {} },
        { provide: AxeAccessibilityScanner, useValue: {} },
        { provide: BasicAuthCryptoService, useValue: {} },
        { provide: UrlPolicyService, useValue: {} },
        { provide: AgentAuditService, useValue: {} },
        {
          provide: scanConfig.KEY,
          useValue: { ...scanConfig(), playwrightWsUrl: null },
        },
      ],
    }).compile();

    // What BullModule's explorer does when it registers the processor.
    const worker = {
      close: async () => {
        events.push('worker closing');
        // The active job finishes while the worker closes.
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('worker closed');
      },
    };
    Object.assign(moduleRef.get(ScanProcessor), { _worker: worker });
    await moduleRef.get(BrowserService).getBrowser();
  });

  it('closes the scan worker, waiting for its active job, before the browser', async () => {
    await moduleRef.close();

    expect(events).toEqual([
      'worker closing',
      'worker closed',
      'browser closed',
    ]);
  });
});
