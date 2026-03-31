import { createStickyNoteSchema } from '../../schemas.js';
import { resolveStickyNote } from '../../transforms.js';
import type { RegisterTool } from './types.js';

export const registerCreateStickyNote: RegisterTool = (server, ctx) => {
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
      const stickyNote = await ctx.miroClient.createStickyNote(
        boardId,
        stickyData,
      );
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
};
