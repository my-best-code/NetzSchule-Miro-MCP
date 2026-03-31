import { getBoardShareLinkSchema } from '../../schemas.js';
import type { RegisterTool } from './types.js';

export const registerGetBoardShareLink: RegisterTool = (server, ctx) => {
  server.registerTool(
    'get_board_share_link',
    {
      description:
        "Get the board view link (direct URL). Note: this returns the board's viewLink from the API, NOT the UI-generated share link with share_link_id. Miro API does not support creating or retrieving UI share links. To get a share link with specific permissions, use the Miro UI: Share > Copy board link.",
      inputSchema: getBoardShareLinkSchema,
    },
    async ({ boardId }) => {
      const boardDetails = await ctx.miroClient.getBoardDetails(boardId);
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
};
