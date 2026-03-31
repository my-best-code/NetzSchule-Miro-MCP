import { getBoardAccessSchema } from '../../schemas.js';
import { formatSharingPolicy } from '../../transforms.js';
import type { RegisterTool } from './types.js';

export const registerGetBoardAccess: RegisterTool = (server, ctx) => {
  server.registerTool(
    'get_board_access',
    {
      description:
        "Get board access information: sharing policy (API-level settings), permissions policy, and list of members with their roles. Note: the 'inviteToAccountAndBoardLinkAccess' field reflects the API-level link access setting, which may differ from the share link configured in Miro UI (share links with share_link_id are a UI-only feature not exposed by the Miro API).",
      inputSchema: getBoardAccessSchema,
    },
    async ({ boardId }) => {
      const [boardDetails, members] = await Promise.all([
        ctx.miroClient.getBoardDetails(boardId),
        ctx.miroClient.getBoardMembers(boardId),
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
};
