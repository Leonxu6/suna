'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Folder,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


import {
  type WorkspaceEntry,
  parseWorkspaceListOutput,
} from '@/lib/utils/kortix-tool-output';

export function WorkspaceListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const output = partOutput(part);
  const workspaces = useMemo(() => parseWorkspaceListOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Folder />}
      trigger={{
        title: 'Workspace',
        subtitle: workspaces.length > 0 ? 'global workspace' : undefined,
      }}
      defaultOpen={defaultOpen || workspaces.length === 0}
      forceOpen={forceOpen}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="project_list" />
      ) : workspaces.length > 0 ? (
        <div className="space-y-0.5">
          {workspaces.map((workspace: WorkspaceEntry) => (
            <div
              key={workspace.path}
              className="text-muted-foreground/70 flex items-center gap-1.5 py-0.5 text-xs"
            >
              <Folder className="text-muted-foreground/50 size-3.5 flex-shrink-0" />
              <span className="truncate">{workspace.name}</span>
              <span className="text-muted-foreground/40 truncate font-mono text-xs">
                {workspace.path}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <OutputBlock text={output.slice(0, 2000)} />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('project_list', WorkspaceListTool);
ToolRegistry.register('project-list', WorkspaceListTool);
ToolRegistry.register('oc-project_list', WorkspaceListTool);
ToolRegistry.register('oc-project-list', WorkspaceListTool);

