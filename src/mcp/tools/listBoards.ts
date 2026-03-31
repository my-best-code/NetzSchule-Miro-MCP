import { z } from 'zod';
import type { BoardFilterParams } from '../../MiroClient.js';
import type { RegisterTool } from './types.js';

export const registerListBoards: RegisterTool = (server, ctx) => {
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
        ...ctx.boardFilter,
        sort,
        ...(query && { query }),
      };
      if (scope === 'mine' && !ctx.boardFilter.teamId) {
        try {
          const tokenContext = await ctx.miroClient.getTokenContext();
          mergedFilter.ownerId = tokenContext.user.id;
        } catch {
          // If token context fails, fall back to all boards
        }
      }
      const response = await ctx.miroClient.getBoardsPage(
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
};
