#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { MiroClient, type BoardFilterParams } from "./MiroClient.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from 'fs/promises';
import path from 'path';

// Parse command line arguments
const argv = await yargs(hideBin(process.argv))
  .option("token", {
    alias: "t",
    type: "string",
    description: "Miro OAuth token",
  })
  .option("team-id", {
    type: "string",
    description: "Filter boards by team ID",
  })
  .option("no-filter", {
    type: "boolean",
    description: "Disable automatic board filtering (show all boards)",
    default: false,
  })
  .help().argv;

// Get token with precedence: command line > environment variable
const oauthToken = (argv.token as string) || process.env.MIRO_OAUTH_TOKEN;

if (!oauthToken) {
  console.error(
    "Error: Miro OAuth token is required. Provide it via MIRO_OAUTH_TOKEN environment variable or --token argument"
  );
  process.exit(1);
}

const server = new McpServer({
  name: "mcp-miro",
  version: "0.2.0",
});

const miroClient = new MiroClient(oauthToken);

// Board filtering configuration
const noFilter = (argv['no-filter'] as boolean) || process.env.MIRO_NO_FILTER === 'true';
const configuredTeamId = (argv['team-id'] as string) || process.env.MIRO_TEAM_ID;

let boardFilter: BoardFilterParams = {};

async function initBoardFilter() {
  if (noFilter) return;

  if (configuredTeamId) {
    boardFilter = { teamId: configuredTeamId };
    return;
  }

  // Auto-detect current user and filter by owner
  try {
    const tokenContext = await miroClient.getTokenContext();
    boardFilter = { ownerId: tokenContext.user.id };
    console.error(`Board filter: showing boards owned by ${tokenContext.user.name} (${tokenContext.user.id})`);
  } catch (err) {
    console.error('Warning: Could not auto-detect user for board filtering. Showing all boards.', err);
  }
}

// --- Resources ---

server.registerResource(
  "board",
  new ResourceTemplate("miro://board/{boardId}", {
    list: async () => {
      const boards = await miroClient.getBoards(boardFilter);
      return {
        resources: boards.map((board) => ({
          uri: `miro://board/${board.id}`,
          mimeType: "application/json",
          name: board.name,
          description: board.description || `Miro board: ${board.name}`,
        })),
      };
    },
  }),
  { description: "Miro board contents" },
  async (uri, { boardId }) => {
    const items = await miroClient.getBoardItems(boardId as string);

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(items, null, 2),
        },
      ],
    };
  }
);

// --- Tools ---

const stickyNoteColors = [
  "gray", "light_yellow", "yellow", "orange",
  "light_green", "green", "dark_green", "cyan",
  "light_pink", "pink", "violet", "red",
  "light_blue", "blue", "dark_blue", "black",
] as const;

const shapeTypes = [
  "rectangle", "round_rectangle", "circle", "triangle",
  "rhombus", "parallelogram", "trapezoid", "pentagon",
  "hexagon", "octagon", "wedge_round_rectangle_callout",
  "star", "flow_chart_predefined_process", "cloud",
  "cross", "can", "right_arrow", "left_arrow",
  "left_right_arrow", "left_brace", "right_brace",
  "flow_chart_connector", "flow_chart_magnetic_disk",
  "flow_chart_input_output", "flow_chart_decision",
  "flow_chart_delay", "flow_chart_display",
  "flow_chart_document", "flow_chart_magnetic_drum",
  "flow_chart_internal_storage", "flow_chart_manual_input",
  "flow_chart_manual_operation", "flow_chart_merge",
  "flow_chart_multidocuments", "flow_chart_note_curly_left",
  "flow_chart_note_curly_right", "flow_chart_note_square",
  "flow_chart_offpage_connector", "flow_chart_or",
  "flow_chart_predefined_process_2", "flow_chart_preparation",
  "flow_chart_process", "flow_chart_online_storage",
  "flow_chart_summing_junction", "flow_chart_terminator",
] as const;

server.registerTool(
  "list_boards",
  {
    description: "List all available Miro boards and their IDs",
  },
  async () => {
    const boards = await miroClient.getBoards(boardFilter);
    const filterInfo = boardFilter.ownerId
      ? ' (filtered: owned by me)'
      : boardFilter.teamId
        ? ` (filtered: team ${boardFilter.teamId})`
        : '';
    return {
      content: [
        {
          type: "text",
          text: `Here are the available Miro boards${filterInfo}:`,
        },
        ...boards.map((b) => ({
          type: "text" as const,
          text: `Board ID: ${b.id}, Name: ${b.name}${b.owner ? `, Owner: ${b.owner.name}` : ''}${b.team ? `, Team: ${b.team.name}` : ''}`,
        })),
      ],
    };
  }
);

server.registerTool(
  "create_sticky_note",
  {
    description:
      "Create a sticky note on a Miro board. By default, sticky notes are 199x228 and available in these colors: gray, light_yellow, yellow, orange, light_green, green, dark_green, cyan, light_pink, pink, violet, red, light_blue, blue, dark_blue, black.",
    inputSchema: {
      boardId: z.string().describe("ID of the board to create the sticky note on"),
      content: z.string().describe("Text content of the sticky note"),
      color: z.enum(stickyNoteColors).default("yellow").describe("Color of the sticky note"),
      x: z.number().default(0).describe("X coordinate position"),
      y: z.number().default(0).describe("Y coordinate position"),
      width: z.number().optional().describe("Width of the sticky note in pixels (default 199, height auto-scales to keep aspect ratio)"),
      height: z.number().optional().describe("Height of the sticky note in pixels (default 228)"),
    },
  },
  async ({ boardId, content, color, x, y, width, height }) => {
    const stickyData: any = {
      data: { content },
      style: { fillColor: color },
      position: { x, y },
    };

    if (width !== undefined || height !== undefined) {
      stickyData.geometry = {};
      if (width !== undefined) stickyData.geometry.width = width;
      if (height !== undefined) stickyData.geometry.height = height;
    }

    const stickyNote = await miroClient.createStickyNote(boardId, stickyData);

    return {
      content: [
        {
          type: "text",
          text: `Created sticky note ${stickyNote.id} on board ${boardId}`,
        },
      ],
    };
  }
);

server.registerTool(
  "bulk_create_items",
  {
    description:
      "Create multiple items on a Miro board in a single transaction (max 20 items)",
    inputSchema: {
      boardId: z.string().describe("ID of the board to create the items on"),
      items: z.array(z.object({
        type: z.enum([
          "app_card", "text", "shape", "sticky_note",
          "image", "document", "card", "frame", "embed",
        ]).describe("Type of item to create"),
        data: z.record(z.string(), z.any()).optional().describe("Item-specific data configuration"),
        style: z.record(z.string(), z.any()).optional().describe("Item-specific style configuration"),
        position: z.record(z.string(), z.any()).optional().describe("Item position configuration"),
        geometry: z.record(z.string(), z.any()).optional().describe("Item geometry configuration"),
        parent: z.record(z.string(), z.any()).optional().describe("Parent item configuration"),
      })).min(1).max(20).describe("Array of items to create"),
    },
  },
  async ({ boardId, items }) => {
    const createdItems = await miroClient.bulkCreateItems(boardId, items);

    return {
      content: [
        {
          type: "text",
          text: `Created ${createdItems.length} items on board ${boardId}`,
        },
      ],
    };
  }
);

server.registerTool(
  "get_frames",
  {
    description: "Get all frames from a Miro board",
    inputSchema: {
      boardId: z.string().describe("ID of the board to get frames from"),
    },
  },
  async ({ boardId }) => {
    const frames = await miroClient.getFrames(boardId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(frames, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "get_items_in_frame",
  {
    description: "Get all items contained within a specific frame on a Miro board",
    inputSchema: {
      boardId: z.string().describe("ID of the board that contains the frame"),
      frameId: z.string().describe("ID of the frame to get items from"),
    },
  },
  async ({ boardId, frameId }) => {
    const items = await miroClient.getItemsInFrame(boardId, frameId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(items, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "create_shape",
  {
    description:
      "Create a shape on a Miro board. Available shapes include basic shapes (rectangle, circle, etc.) and flowchart shapes (process, decision, etc.). Standard geometry specs: width and height in pixels (default 200x200)",
    inputSchema: {
      boardId: z.string().describe("ID of the board to create the shape on"),
      shape: z.enum(shapeTypes).default("rectangle").describe("Type of shape to create"),
      content: z.string().optional().describe("Text content to display on the shape"),
      style: z.object({
        borderColor: z.string().optional(),
        borderOpacity: z.number().min(0).max(1).optional(),
        borderStyle: z.enum(["normal", "dotted", "dashed"]).optional(),
        borderWidth: z.number().min(1).max(24).optional(),
        color: z.string().optional(),
        fillColor: z.string().optional(),
        fillOpacity: z.number().min(0).max(1).optional(),
        fontFamily: z.string().optional(),
        fontSize: z.number().min(10).max(288).optional(),
        textAlign: z.enum(["left", "center", "right"]).optional(),
        textAlignVertical: z.enum(["top", "middle", "bottom"]).optional(),
      }).optional().describe("Style configuration for the shape"),
      position: z.object({
        x: z.number().default(0),
        y: z.number().default(0),
        origin: z.string().default("center"),
      }).optional().describe("Position configuration"),
      geometry: z.object({
        width: z.number().default(200),
        height: z.number().default(200),
        rotation: z.number().default(0),
      }).optional().describe("Geometry configuration"),
    },
  },
  async ({ boardId, shape, content, style, position, geometry }) => {
    const shapeItem = await miroClient.createShape(boardId, {
      data: {
        shape,
        content,
      },
      style: style || {},
      position: position || { x: 0, y: 0 },
      geometry: geometry || { width: 200, height: 200, rotation: 0 },
    });

    return {
      content: [
        {
          type: "text",
          text: `Created ${shape} shape with ID ${shapeItem.id} on board ${boardId}`,
        },
      ],
    };
  }
);

server.registerTool(
  "get_board_access",
  {
    description: "Get board access information: sharing policy, permissions policy, and list of members with their roles",
    inputSchema: {
      boardId: z.string().describe("ID of the board to get access information for"),
    },
  },
  async ({ boardId }) => {
    const [boardDetails, members] = await Promise.all([
      miroClient.getBoardDetails(boardId),
      miroClient.getBoardMembers(boardId),
    ]);

    const lines: string[] = [`Board: ${boardDetails.name} (${boardDetails.id})`];

    if (boardDetails.sharingPolicy) {
      const sp = boardDetails.sharingPolicy;
      lines.push('', 'Sharing Policy:');
      if (sp.access) lines.push(`  Access: ${sp.access}`);
      if (sp.teamAccess) lines.push(`  Team access: ${sp.teamAccess}`);
      if (sp.organizationAccess) lines.push(`  Organization access: ${sp.organizationAccess}`);
      if (sp.inviteToAccountAndBoardLinkAccess) lines.push(`  Link access: ${sp.inviteToAccountAndBoardLinkAccess}`);
    }

    if (boardDetails.permissionsPolicy) {
      const pp = boardDetails.permissionsPolicy;
      lines.push('', 'Permissions Policy:');
      if (pp.copyAccess) lines.push(`  Copy access: ${pp.copyAccess}`);
      if (pp.sharingAccess) lines.push(`  Sharing access: ${pp.sharingAccess}`);
    }

    lines.push('', `Members (${members.length}):`);
    const roleOrder = ['owner', 'coowner', 'editor', 'commenter', 'viewer'];
    const sorted = [...members].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
    for (const m of sorted) {
      lines.push(`  ${m.role}: ${m.name} (id: ${m.id})`);
    }

    return {
      content: [{ type: "text", text: lines.join('\n') }],
    };
  }
);

server.registerTool(
  "update_board_sharing",
  {
    description: "Update board sharing policy: configure team access level and link access permissions",
    inputSchema: {
      boardId: z.string().describe("ID of the board to update sharing settings for"),
      access: z.enum(["private", "view", "comment", "edit"]).optional()
        .describe("Board access level: private, view, comment, or edit"),
      teamAccess: z.enum(["private", "view", "comment", "edit"]).optional()
        .describe("Team access level: private, view, comment, or edit"),
      organizationAccess: z.enum(["private", "view", "comment", "edit"]).optional()
        .describe("Organization access level: private, view, comment, or edit"),
      inviteToAccountAndBoardLinkAccess: z.enum(["viewer", "commenter", "editor", "no_access"]).optional()
        .describe("Access level for anyone with the board link"),
    },
  },
  async ({ boardId, access, teamAccess, organizationAccess, inviteToAccountAndBoardLinkAccess }) => {
    const sharingPolicy: Record<string, string> = {};
    if (access) sharingPolicy.access = access;
    if (teamAccess) sharingPolicy.teamAccess = teamAccess;
    if (organizationAccess) sharingPolicy.organizationAccess = organizationAccess;
    if (inviteToAccountAndBoardLinkAccess) sharingPolicy.inviteToAccountAndBoardLinkAccess = inviteToAccountAndBoardLinkAccess;

    if (Object.keys(sharingPolicy).length === 0) {
      return {
        content: [{ type: "text", text: "Error: At least one sharing policy field must be provided" }],
      };
    }

    await miroClient.updateBoardSharingPolicy(boardId, sharingPolicy);

    // Verify with fresh GET to confirm actual state
    const verified = await miroClient.getBoardDetails(boardId);
    const sp = verified.sharingPolicy;

    const lines = [`Updated sharing policy for board: ${verified.name} (${verified.id})`];
    lines.push('', 'Current Sharing Policy (verified):');
    if (sp?.access) lines.push(`  Access: ${sp.access}`);
    if (sp?.teamAccess) lines.push(`  Team access: ${sp.teamAccess}`);
    if (sp?.organizationAccess) lines.push(`  Organization access: ${sp.organizationAccess}`);
    lines.push(`  Link access: ${sp?.inviteToAccountAndBoardLinkAccess ?? 'no_access'}`);

    // Warn if requested link access didn't apply
    if (inviteToAccountAndBoardLinkAccess &&
        sp?.inviteToAccountAndBoardLinkAccess !== inviteToAccountAndBoardLinkAccess) {
      lines.push('', `Warning: Link access was requested as "${inviteToAccountAndBoardLinkAccess}" but is still "${sp?.inviteToAccountAndBoardLinkAccess ?? 'no_access'}".`);
      lines.push('This may be a limitation of your Miro plan or account settings.');
      lines.push('Try changing this setting manually in Miro: Share > "Anyone with the link" > Editor');
    }

    return {
      content: [{ type: "text", text: lines.join('\n') }],
    };
  }
);

server.registerTool(
  "get_board_share_link",
  {
    description: "Get the shareable link for a Miro board",
    inputSchema: {
      boardId: z.string().describe("ID of the board to get the share link for"),
    },
  },
  async ({ boardId }) => {
    const boardDetails = await miroClient.getBoardDetails(boardId);
    const link = boardDetails.viewLink || `https://miro.com/app/board/${boardId}/`;

    return {
      content: [{ type: "text", text: `Share link for "${boardDetails.name}": ${link}` }],
    };
  }
);

// --- Prompts ---

server.registerPrompt(
  "Working with MIRO",
  {
    description: "Basic prompt for working with MIRO boards",
  },
  async () => {
    const keyFactsPath = path.join(process.cwd(), 'resources', 'boards-key-facts.md');
    const keyFacts = await fs.readFile(keyFactsPath, 'utf-8');
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: keyFacts,
          },
        },
      ],
    };
  }
);

// --- Start ---

async function main() {
  await initBoardFilter();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
