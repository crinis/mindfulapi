import { Injectable } from '@nestjs/common';
import { IRuleService } from '../interfaces/rule-service.interface';
import { RuleService } from './rule.service';
import { AxeRuleService } from './axe-rule.service';
import { ScannerType, DEFAULT_SCANNER_TYPE } from '../enums/scanner-type.enum';

/**
 * Factory service for creating rule service instances.
 * 
 * This service provides the appropriate rule service implementation
 * based on the scanner type being used. Different scanners may provide
 * help URLs in different ways, so this factory ensures the correct
 * rule service is used for URL generation.
 */
@Injectable()
export class RuleServiceFactory {
  constructor(
    private readonly htmlcsRuleService: RuleService,
    private readonly axeRuleService: AxeRuleService,
  ) {}

  /**
   * Creates a rule service instance based on the specified scanner type.
   * 
   * @param scannerType - The type of scanner being used (defaults to HTMLCS)
   * @returns The appropriate rule service implementation
   * @throws {Error} When an unsupported scanner type is requested
   */
  getRuleService(scannerType: ScannerType = DEFAULT_SCANNER_TYPE): IRuleService {
    switch (scannerType) {
      case ScannerType.HTMLCS:
        return this.htmlcsRuleService;
      case ScannerType.AXE:
        return this.axeRuleService;
      default:
        throw new Error(`Unsupported scanner type: ${scannerType}`);
    }
  }
}
