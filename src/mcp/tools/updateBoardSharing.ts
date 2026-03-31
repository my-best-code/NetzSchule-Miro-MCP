import { updateBoardSharingSchema } from '../../schemas.js';
import { formatSharingPolicy } from '../../transforms.js';
import type { RegisterTool } from './types.js';

export const registerUpdateBoardSharing: RegisterTool = (server, ctx) => {
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

      await ctx.miroClient.updateBoardSharingPolicy(boardId, sharingPolicy);
      const verified = await ctx.miroClient.getBoardDetails(boardId);
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
};
