import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BoardFilterParams, MiroClient } from '../../MiroClient.js';

export interface ToolContext {
  miroClient: MiroClient;
  boardFilter: BoardFilterParams;
}

export type RegisterTool = (server: McpServer, ctx: ToolContext) => void;
