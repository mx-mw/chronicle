import type { LocatedSessionManifest } from './session-manifest.js';

export interface ActionableSessionPage {
  text: string;
  page: number;
  pages: number;
  total: number;
}

/** Newest-first, bounded Discord status output with discoverable pagination. */
export function formatActionableSessionPage(
  sessions: LocatedSessionManifest[],
  options: { excludeSessionId?: string; page?: number; pageSize?: number } = {},
): ActionableSessionPage {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 10));
  const filtered = sessions
    .filter(({ manifest }) => manifest.id !== options.excludeSessionId)
    .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const page = Math.min(requestedPage, pages);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const lines = visible.map(({ manifest }) => `${manifest.id} (${manifest.stage})`);
  if (filtered.length > pageSize) {
    lines.push(`Page ${page}/${pages} · use \`/record status page:<number>\` to see every session ID.`);
  }
  return { text: lines.join('\n'), page, pages, total: filtered.length };
}
