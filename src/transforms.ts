import type { MiroSharingPolicy, StickyNoteData } from './MiroClient.js';
import { STICKY_SIZE_PRESETS } from './schemas.js';

export interface StickyNoteParams {
  boardId: string;
  content: string;
  color: string;
  x: number;
  y: number;
  size?: string;
  width?: number;
  shape: 'square' | 'rectangle';
  parentId?: string;
}

export function resolveStickyNote(params: StickyNoteParams): {
  stickyData: StickyNoteData;
  finalWidth?: number;
  finalShape: string;
} {
  let finalWidth = params.width;
  let finalShape: 'square' | 'rectangle' = params.shape;

  if (params.size) {
    finalWidth = finalWidth ?? STICKY_SIZE_PRESETS[params.size];
    finalShape = 'rectangle';
  }

  const stickyData: StickyNoteData = {
    data: { content: params.content, shape: finalShape },
    style: { fillColor: params.color },
    position: { x: params.x, y: params.y },
  };

  if (finalWidth !== undefined) {
    stickyData.geometry = { width: finalWidth };
  }

  if (params.parentId) {
    stickyData.parent = { id: params.parentId };
  }

  return { stickyData, finalWidth, finalShape };
}

export function transformBulkItems(items: any[]): any[] {
  return items.map((item) => {
    const transformed: any = { ...item };

    // Resolve size preset
    if (transformed.size && transformed.type === 'sticky_note') {
      const presetWidth = STICKY_SIZE_PRESETS[transformed.size];
      if (presetWidth) {
        transformed.geometry = { ...transformed.geometry, width: presetWidth };
        transformed.data = { ...transformed.data, shape: 'rectangle' };
      }
      delete transformed.size;
    }

    // Resolve custom width
    if (transformed.width !== undefined && transformed.type === 'sticky_note') {
      transformed.geometry = {
        ...transformed.geometry,
        width: transformed.width,
      };
      delete transformed.width;
    }

    // Resolve color shorthand
    if (transformed.color) {
      transformed.style = {
        ...transformed.style,
        fillColor: transformed.color,
      };
      delete transformed.color;
    }

    // Strip non-API position fields
    if (transformed.position) {
      const { origin, relativeTo, ...cleanPos } = transformed.position;
      transformed.position = cleanPos;
    }

    return transformed;
  });
}

export function formatSharingPolicy(
  sp: MiroSharingPolicy | undefined,
): string[] {
  if (!sp) return [];
  const lines: string[] = [];
  if (sp.access) lines.push(`  Access: ${sp.access}`);
  if (sp.teamAccess) lines.push(`  Team access: ${sp.teamAccess}`);
  if (sp.organizationAccess)
    lines.push(`  Organization access: ${sp.organizationAccess}`);
  lines.push(
    `  Link access (API-level): ${sp.inviteToAccountAndBoardLinkAccess ?? 'no_access'}`,
  );
  return lines;
}
