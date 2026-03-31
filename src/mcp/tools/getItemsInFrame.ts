import { getItemsInFrameSchema } from '../../schemas.js';
import type { RegisterTool } from './types.js';

export const registerGetItemsInFrame: RegisterTool = (server, ctx) => {
  server.registerTool(
    'get_items_in_frame',
    {
      description:
        'Get all items contained within a specific frame on a Miro board',
      inputSchema: getItemsInFrameSchema,
    },
    async ({ boardId, frameId }) => {
      const items = await ctx.miroClient.getItemsInFrame(boardId, frameId);
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
};
