import { getFramesSchema } from '../../schemas.js';
import type { RegisterTool } from './types.js';

export const registerGetFrames: RegisterTool = (server, ctx) => {
  server.registerTool(
    'get_frames',
    {
      description: 'Get all frames from a Miro board',
      inputSchema: getFramesSchema,
    },
    async ({ boardId }) => {
      const frames = await ctx.miroClient.getFrames(boardId);
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
};
