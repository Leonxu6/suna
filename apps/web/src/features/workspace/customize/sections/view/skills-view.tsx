'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { Sparkles } from 'lucide-react';

type Skill = ConfigEntity;

export function SkillsView({ workspaceId }: { workspaceId: string }) {
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SKILL_WRITE).allowed === true;
  return (
    <ConfigEntityView<Skill>
      workspaceId={workspaceId}
      kind="skill"
      noun="skill"
      layout="split"
      canWrite={canWrite}
      title="Skills"
      searchPlaceholder="Search skills"
      emptyIcon={Sparkles}
      emptyTitle="No skills yet"
      emptyDescription="Create a skill to give agents reusable capabilities."
      emptyDocsHref="https://opencode.ai/docs/skills/"
      emptyBodyLabel="Skill body is empty. Add content below the frontmatter."
      select={(config) => config.skills}
      renderTriggerLabel={(skill) => skill.name}
      renderDetailTitle={(skill) => skill.name}
    />
  );
}
