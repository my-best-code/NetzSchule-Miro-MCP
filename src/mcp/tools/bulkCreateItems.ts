import { bulkCreateItemsSchema } from '../../schemas.js';
import { transformBulkItems } from '../../transforms.js';
import type { RegisterTool } from './types.js';

export const registerBulkCreateItems: RegisterTool = (server, ctx) => {
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
      const createdItems = await ctx.miroClient.bulkCreateItems(
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
};
