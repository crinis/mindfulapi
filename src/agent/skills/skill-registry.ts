import { Injectable } from '@nestjs/common';
import { AgentSkill } from '../../enums/agent-skill.enum';
import type { AuditSkill } from './audit-skill.interface';
import { ImageAltTextSkill } from './image-alt-text.skill';
import { HeadingStructureSkill } from './heading-structure.skill';
import { LinkPurposeSkill } from './link-purpose.skill';

/**
 * Central registry of available audit skills. Resolves a client's requested
 * skills against the server whitelist and returns them in execution order.
 */
@Injectable()
export class SkillRegistry {
  private readonly skills: Map<AgentSkill, AuditSkill>;

  constructor(
    imageAltTextSkill: ImageAltTextSkill,
    headingStructureSkill: HeadingStructureSkill,
    linkPurposeSkill: LinkPurposeSkill,
  ) {
    this.skills = new Map<AgentSkill, AuditSkill>([
      [imageAltTextSkill.id, imageAltTextSkill],
      [headingStructureSkill.id, headingStructureSkill],
      [linkPurposeSkill.id, linkPurposeSkill],
    ]);
  }

  /** All registered skill ids (for validation/whitelisting). */
  knownSkills(): AgentSkill[] {
    return [...this.skills.keys()];
  }

  /**
   * Resolves the intersection of requested skills and the server-permitted
   * whitelist into concrete, order-sorted skills. Unknown or non-whitelisted
   * ids are dropped.
   */
  resolve(requested: AgentSkill[], allowed: string[]): AuditSkill[] {
    const allowedSet = new Set(allowed);
    const seen = new Set<AgentSkill>();
    const resolved: AuditSkill[] = [];
    for (const id of requested) {
      if (seen.has(id) || !allowedSet.has(id)) continue;
      const skill = this.skills.get(id);
      if (!skill) continue;
      seen.add(id);
      resolved.push(skill);
    }
    return resolved.sort((a, b) => a.order - b.order);
  }
}
