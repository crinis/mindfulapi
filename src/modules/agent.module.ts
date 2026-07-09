import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { ModelProviderFactory } from '../agent/harness/model-provider.factory';
import { AgentHarnessService } from '../agent/harness/agent-harness.service';
import { SkillRegistry } from '../agent/skills/skill-registry';
import { ImageAltTextSkill } from '../agent/skills/image-alt-text.skill';
import { HeadingStructureSkill } from '../agent/skills/heading-structure.skill';
import { LinkPurposeSkill } from '../agent/skills/link-purpose.skill';
import { AgentAuditService } from '../agent/agent-audit.service';

/**
 * Infrastructure module for the optional LLM-agent audit layer: the model
 * harness, the skill registry + skills, and the audit orchestrator. Exports
 * {@link AgentAuditService} for the scan processor and {@link AgentFinding}
 * repository access for the scan service.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Scan, AgentFinding])],
  providers: [
    ModelProviderFactory,
    AgentHarnessService,
    SkillRegistry,
    ImageAltTextSkill,
    HeadingStructureSkill,
    LinkPurposeSkill,
    AgentAuditService,
  ],
  exports: [AgentAuditService, TypeOrmModule],
})
export class AgentModule {}
