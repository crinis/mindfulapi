import { Injectable } from '@nestjs/common';
import { RuleResponseDto } from '../dto/scan/response';
import * as axe from 'axe-core';

/**
 * Service for retrieving axe-core accessibility rule metadata.
 */
@Injectable()
export class RulesService {
  /** Cached rule list — axe-core rules are static and never change at runtime. */
  private readonly rules: RuleResponseDto[] = axe
    .getRules()
    .map((rule) => ({
      id: rule.ruleId,
      description: rule.description,
      helpUrl: rule.helpUrl,
      tags: rule.tags,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  /**
   * Returns all axe-core accessibility rules with their metadata.
   */
  getRules(): RuleResponseDto[] {
    return this.rules;
  }
}
