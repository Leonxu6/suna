import { redirect } from 'next/navigation';
import { legacyWorkspaceDestination } from '@/lib/workspace-navigation';

type LegacyWorkspacesPageProps = {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LegacyWorkspacesPage({
  params,
  searchParams,
}: LegacyWorkspacesPageProps) {
  const { slug = [] } = await params;
  redirect(legacyWorkspaceDestination(slug, await searchParams));
}
