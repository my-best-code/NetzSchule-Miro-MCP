import { createShapeSchema } from '../../schemas.js';
import type { RegisterTool } from './types.js';

export const registerCreateShape: RegisterTool = (server, ctx) => {
  server.registerTool(
    'create_shape',
    {
      description:
        'Create a shape on a Miro board. Available shapes include basic shapes (rectangle, circle, etc.) and flowchart shapes (process, decision, etc.). Standard geometry specs: width and height in pixels (default 200x200)',
      inputSchema: createShapeSchema,
    },
    async ({ boardId, shape, content, style, position, geometry }) => {
      const shapeItem = await ctx.miroClient.createShape(boardId, {
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
};
