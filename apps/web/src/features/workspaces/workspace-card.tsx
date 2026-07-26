import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Loading from '@/components/ui/loading';
import { useIsMobile } from '@/hooks/utils';
import { relativeTime } from '@/lib/kortix/task-meta';
import { KortixWorkspace } from '@kortix/sdk';
import { ArrowUpRight, Pencil, TrashSolid } from '@mynaui/icons-react';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

const WorkspaceCard = ({
  workspace,
  onOpen,
  onRename,
  onArchive,
  archiving,
}: {
  workspace: KortixWorkspace;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
  archiving: boolean;
}) => {
  const isMobile = useIsMobile();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const updatedLabel = relativeTime(workspace.updated_at);
  const canManageWorkspace =
    workspace.effective_workspace_role === 'manager' || !workspace.effective_workspace_role;

  return (
    <Card className="group bg-secondary/80 hover:bg-secondary relative p-0 transition-[background-color,transform] duration-150 ease-out has-[[data-card-press]:active]:scale-[0.98]">
      <button
        type="button"
        data-card-press
        onClick={onOpen}
        className="cursor-pointer px-5 py-4 text-left"
      >
        <div className="flex w-full items-center gap-3">
          <EntityAvatar label={workspace.name} size="lg" className="bg-background" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3
              title={workspace.name}
              className="text-foreground truncate text-sm leading-tight font-semibold"
            >
              {workspace.name}
            </h3>
            <p className="text-muted-foreground truncate text-xs tabular-nums">
              Updated {updatedLabel}
            </p>
          </div>
        </div>
      </button>

      <div className="absolute top-3 right-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              aria-label={tHardcodedUi.raw('appWorkspacesPage.line103JsxAttrAriaLabelWorkspaceActions')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={isMobile ? 'end' : 'start'} className="w-44">
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowUpRight className="size-4" />
              {tHardcodedUi.raw('appWorkspacesPage.line109JsxTextOpenWorkspace')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename} disabled={!canManageWorkspace}>
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={onArchive}
              disabled={archiving || !canManageWorkspace}
            >
              {archiving ? <Loading className="size-4 shrink-0" /> : <TrashSolid className="size-4" />}
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
};

export default WorkspaceCard;
