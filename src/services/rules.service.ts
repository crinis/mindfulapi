import { Injectable, Logger } from '@nestjs/common';
import { RuleResponseDto } from '../dto/scan-response.dto';
import * as axe from 'axe-core';

/**
 * Service for retrieving axe-core accessibility rule metadata.
 */
@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  /**
   * Returns all axe-core accessibility rules with their metadata.
   */
  getRules(): RuleResponseDto[] {
    this.logger.log('Loading axe-core rules');

    const rules = axe.getRules();

    return rules
      .map((rule) => ({
        id: rule.ruleId,
        description: rule.description,
        helpUrl: rule.helpUrl,
        tags: rule.tags,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
