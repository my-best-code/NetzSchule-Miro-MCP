import {
  type McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BoardFilterParams, MiroClient } from '../MiroClient.js';
import { registerBulkCreateItems } from './tools/bulkCreateItems.js';
import { registerCreateShape } from './tools/createShape.js';
import { registerCreateStickyNote } from './tools/createStickyNote.js';
import { registerGetBoardAccess } from './tools/getBoardAccess.js';
import { registerGetBoardShareLink } from './tools/getBoardShareLink.js';
import { registerGetFrames } from './tools/getFrames.js';
import { registerGetItemsInFrame } from './tools/getItemsInFrame.js';
import { registerListBoards } from './tools/listBoards.js';
import type { RegisterTool } from './tools/types.js';
import { registerUpdateBoardSharing } from './tools/updateBoardSharing.js';

const tools: RegisterTool[] = [
  registerListBoards,
  registerCreateStickyNote,
  registerBulkCreateItems,
  registerGetFrames,
  registerGetItemsInFrame,
  registerCreateShape,
  registerGetBoardAccess,
  registerUpdateBoardSharing,
  registerGetBoardShareLink,
];

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

  const ctx = { miroClient, boardFilter };
  for (const register of tools) {
    register(server, ctx);
  }

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
