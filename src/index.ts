#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { MiroClient, type BoardFilterParams } from "./MiroClient.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from 'fs/promises';
import path from 'path';
import { registerMcpTools } from "./mcp/registerTools.js";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf-8'));

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
  version: pkg.version,
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

// --- Start ---

async function main() {
  await initBoardFilter();

  const keyFactsPath = path.join(__dirname, '..', 'resources', 'boards-key-facts.md');
  const keyFactsContent = await fs.readFile(keyFactsPath, 'utf-8');
  registerMcpTools(server, miroClient, boardFilter, keyFactsContent);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
