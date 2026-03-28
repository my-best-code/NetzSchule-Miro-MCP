import {
  type McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BoardFilterParams, MiroClient } from '../MiroClient.js';
import {
  bulkCreateItemsSchema,
  createShapeSchema,
  createStickyNoteSchema,
  getBoardAccessSchema,
  getBoardShareLinkSchema,
  getFramesSchema,
  getItemsInFrameSchema,
  updateBoardSharingSchema,
} from '../schemas.js';
import {
  formatSharingPolicy,
  resolveStickyNote,
  transformBulkItems,
} from '../transforms.js';

export function registerMcpTools(
  server: McpServer,
  miroClient: MiroClient,
  boardFilter: BoardFilterParams,
  keyFactsContent: string,
): void {
  // --- Resources ---

  server.registerResource(
    'board',
    new ResourceTemplate('miro://board/{boardId}', {
      list: async () => {
        const boards = await miroClient.getBoards(boardFilter);
        return {
          resources: boards.map((board) => ({
            uri: `miro://board/${board.id}`,
            mimeType: 'application/json',
            name: board.name,
            description: board.description || `Miro board: ${board.name}`,
          })),
        };
      },
    }),
    { description: 'Miro board contents' },
    async (uri, { boardId }) => {
      const items = await miroClient.getBoardItems(boardId as string);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    },
  );

  // --- Tools ---

  server.registerTool(
    'list_boards',
    {
      description:
        'List available Miro boards (paginated). By default returns 20 most recently modified boards owned by the current user. ' +
        "Set `scope` to 'all' to see all accessible boards (including other team members' boards). " +
        'Response includes total board count — use offset to paginate through all boards. ' +
        'Use `query` to search boards by name. Use `sort` to change sort order.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Max boards to return (1-50, default 20)'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Number of boards to skip (for pagination, default 0)'),
        sort: z
          .enum([
            'default',
            'last_modified',
            'last_opened',
            'last_created',
            'alphabetically',
          ])
          .default('last_modified')
          .describe('Sort order (default: last_modified)'),
        query: z.string().max(500).optional().describe('Search boards by name'),
        scope: z
          .enum(['mine', 'all'])
          .default('mine')
          .describe(
            "'mine' = only my boards (default), 'all' = all accessible boards",
          ),
      },
    },
    async ({ limit, offset, sort, query, scope }) => {
      const mergedFilter: BoardFilterParams = {
        ...boardFilter,
        sort,
        ...(query && { query }),
      };
      if (scope === 'mine' && !boardFilter.teamId) {
        try {
          const tokenContext = await miroClient.getTokenContext();
          mergedFilter.ownerId = tokenContext.user.id;
        } catch {
          // If token context fails, fall back to all boards
        }
      }
      const response = await miroClient.getBoardsPage(
        mergedFilter,
        limit,
        offset,
      );
      const scopeInfo = mergedFilter.ownerId
        ? ' (my boards)'
        : mergedFilter.teamId
          ? ` (team ${mergedFilter.teamId})`
          : ' (all accessible)';
      const sortInfo = sort !== 'default' ? `, sorted by ${sort}` : '';
      const queryInfo = query ? `, search: "${query}"` : '';
      const paginationInfo = `Showing ${response.data.length} of ${response.total} boards (offset: ${offset}${sortInfo}${queryInfo})${scopeInfo}`;
      return {
        content: [
          {
            type: 'text',
            text: paginationInfo,
          },
          ...response.data.map((b) => ({
            type: 'text' as const,
            text: `Board ID: ${b.id}, Name: ${b.name}${b.owner ? `, Owner: ${b.owner.name}` : ''}${b.team ? `, Team: ${b.team.name}` : ''}`,
          })),
        ],
      };
    },
  );

  server.registerTool(
    'create_sticky_note',
    {
      description:
        'Create a sticky note on a Miro board. Available colors: gray, light_yellow, yellow, orange, light_green, green, dark_green, cyan, light_pink, pink, violet, red, light_blue, blue, dark_blue, black. ' +
        'Size presets (rectangular, each ~2x the previous): klitzeklein (325), klein (650), medium (1300), mittelgroß (2600), groß (5600), riesengroß (11200). ' +
        "Use 'size' for presets or 'width' for custom size. Shape can be 'square' (default) or 'rectangle'.",
      inputSchema: createStickyNoteSchema,
    },
    async ({ boardId, content, color, x, y, size, width, shape, parentId }) => {
      const { stickyData, finalWidth, finalShape } = resolveStickyNote({
        boardId,
        content,
        color,
        x,
        y,
        size,
        width,
        shape,
        parentId,
      });
      const stickyNote = await miroClient.createStickyNote(boardId, stickyData);
      return {
        content: [
          {
            type: 'text',
            text:
              `Created ${finalShape} sticky note ${stickyNote.id} on board ${boardId}` +
              (size ? ` (size: ${size}, width: ${finalWidth})` : ''),
          },
        ],
      };
    },
  );

  server.registerTool(
    'bulk_create_items',
    {
      description:
        'Create multiple items on a Miro board in a single transaction (max 20 items). ' +
        'Supports same size presets as create_sticky_note: klitzeklein, klein, medium, mittelgroß, groß, riesengroß. ' +
        'Use parent.id to place items inside a frame. For sticky notes: use fillColor in style, data.shape for rectangle.',
      inputSchema: bulkCreateItemsSchema,
    },
    async ({ boardId, items }) => {
      const transformedItems = transformBulkItems(items);
      const createdItems = await miroClient.bulkCreateItems(
        boardId,
        transformedItems,
      );
      return {
        content: [
          {
            type: 'text',
            text: `Created ${createdItems.length} items on board ${boardId}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_frames',
    {
      description: 'Get all frames from a Miro board',
      inputSchema: getFramesSchema,
    },
    async ({ boardId }) => {
      const frames = await miroClient.getFrames(boardId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(frames, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_items_in_frame',
    {
      description:
        'Get all items contained within a specific frame on a Miro board',
      inputSchema: getItemsInFrameSchema,
    },
    async ({ boardId, frameId }) => {
      const items = await miroClient.getItemsInFrame(boardId, frameId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_shape',
    {
      description:
        'Create a shape on a Miro board. Available shapes include basic shapes (rectangle, circle, etc.) and flowchart shapes (process, decision, etc.). Standard geometry specs: width and height in pixels (default 200x200)',
      inputSchema: createShapeSchema,
    },
    async ({ boardId, shape, content, style, position, geometry }) => {
      const shapeItem = await miroClient.createShape(boardId, {
        data: { shape, content },
        style: style || {},
        position: position || { x: 0, y: 0 },
        geometry: geometry || { width: 200, height: 200, rotation: 0 },
      });
      return {
        content: [
          {
            type: 'text',
            text: `Created ${shape} shape with ID ${shapeItem.id} on board ${boardId}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_board_access',
    {
      description:
        "Get board access information: sharing policy (API-level settings), permissions policy, and list of members with their roles. Note: the 'inviteToAccountAndBoardLinkAccess' field reflects the API-level link access setting, which may differ from the share link configured in Miro UI (share links with share_link_id are a UI-only feature not exposed by the Miro API).",
      inputSchema: getBoardAccessSchema,
    },
    async ({ boardId }) => {
      const [boardDetails, members] = await Promise.all([
        miroClient.getBoardDetails(boardId),
        miroClient.getBoardMembers(boardId),
      ]);

      const lines: string[] = [
        `Board: ${boardDetails.name} (${boardDetails.id})`,
      ];

      if (boardDetails.sharingPolicy) {
        lines.push(
          '',
          'Sharing Policy:',
          ...formatSharingPolicy(boardDetails.sharingPolicy),
        );
        const linkAccess =
          boardDetails.sharingPolicy.inviteToAccountAndBoardLinkAccess;
        if (linkAccess === 'no_access' || !linkAccess) {
          lines.push(
            '    Note: This reflects the API-level setting. The board may still have a UI-generated share link (with share_link_id) that grants access independently. Miro API does not expose UI share links.',
          );
        }
      }

      if (boardDetails.permissionsPolicy) {
        const pp = boardDetails.permissionsPolicy;
        lines.push('', 'Permissions Policy:');
        if (pp.copyAccess) lines.push(`  Copy access: ${pp.copyAccess}`);
        if (pp.sharingAccess)
          lines.push(`  Sharing access: ${pp.sharingAccess}`);
      }

      lines.push('', `Members (${members.length}):`);
      const roleOrder = ['owner', 'coowner', 'editor', 'commenter', 'viewer'];
      const sorted = [...members].sort(
        (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role),
      );
      for (const m of sorted) {
        lines.push(`  ${m.role}: ${m.name} (id: ${m.id})`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  server.registerTool(
    'update_board_sharing',
    {
      description:
        'Update board sharing policy via Miro API: configure access, team access, and organization access levels. Note: inviteToAccountAndBoardLinkAccess may be restricted by organization settings. UI-generated share links (with share_link_id) cannot be created or modified via the API.',
      inputSchema: updateBoardSharingSchema,
    },
    async ({
      boardId,
      access,
      teamAccess,
      organizationAccess,
      inviteToAccountAndBoardLinkAccess,
    }) => {
      const sharingPolicy: Record<string, string> = {};
      if (access) sharingPolicy.access = access;
      if (teamAccess) sharingPolicy.teamAccess = teamAccess;
      if (organizationAccess)
        sharingPolicy.organizationAccess = organizationAccess;
      if (inviteToAccountAndBoardLinkAccess)
        sharingPolicy.inviteToAccountAndBoardLinkAccess =
          inviteToAccountAndBoardLinkAccess;

      if (Object.keys(sharingPolicy).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: At least one sharing policy field must be provided',
            },
          ],
        };
      }

      await miroClient.updateBoardSharingPolicy(boardId, sharingPolicy);
      const verified = await miroClient.getBoardDetails(boardId);
      const sp = verified.sharingPolicy;

      const lines = [
        `Updated sharing policy for board: ${verified.name} (${verified.id})`,
      ];
      lines.push(
        '',
        'Current Sharing Policy (verified):',
        ...formatSharingPolicy(sp),
      );

      if (
        inviteToAccountAndBoardLinkAccess &&
        sp?.inviteToAccountAndBoardLinkAccess !==
          inviteToAccountAndBoardLinkAccess
      ) {
        lines.push(
          '',
          `Warning: inviteToAccountAndBoardLinkAccess was requested as "${inviteToAccountAndBoardLinkAccess}" but is still "${sp?.inviteToAccountAndBoardLinkAccess ?? 'no_access'}".`,
        );
        lines.push('This is likely restricted by your organization settings.');
        lines.push(
          'Note: UI-generated share links (with share_link_id) are a separate mechanism not accessible via the Miro API.',
        );
        lines.push(
          'To manage share links, use the Miro UI: Share > "Anyone with the link".',
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  server.registerTool(
    'get_board_share_link',
    {
      description:
        "Get the board view link (direct URL). Note: this returns the board's viewLink from the API, NOT the UI-generated share link with share_link_id. Miro API does not support creating or retrieving UI share links. To get a share link with specific permissions, use the Miro UI: Share > Copy board link.",
      inputSchema: getBoardShareLinkSchema,
    },
    async ({ boardId }) => {
      const boardDetails = await miroClient.getBoardDetails(boardId);
      const link =
        boardDetails.viewLink || `https://miro.com/app/board/${boardId}/`;
      const linkAccess =
        boardDetails.sharingPolicy?.inviteToAccountAndBoardLinkAccess ??
        'no_access';

      const lines = [
        `Board view link for "${boardDetails.name}": ${link}`,
        '',
        `API-level link access: ${linkAccess}`,
        '',
        "Note: This is the board's direct URL (viewLink), not a UI-generated share link.",
        'Miro UI share links (with ?share_link_id=...) grant access independently and',
        'cannot be created or retrieved via the Miro API.',
        'To generate a share link with specific permissions, use Miro UI: Share > Copy board link.',
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  // --- Prompts ---

  server.registerPrompt(
    'Working with MIRO',
    {
      description: 'Basic prompt for working with MIRO boards',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: keyFactsContent,
            },
          },
        ],
      };
    },
  );
}
