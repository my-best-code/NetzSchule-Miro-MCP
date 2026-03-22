import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MiroClient, type BoardFilterParams } from "../MiroClient.js";
import { registerMcpTools } from "./registerTools.js";
// @ts-ignore — esbuild bundles .md as text via --loader:.md=text
import keyFactsContent from "../../resources/boards-key-facts.md";
// @ts-ignore — esbuild resolves JSON imports at bundle time
import pkg from "../../package.json";

const VERSION = pkg.version;
const TEAM_ID = process.env.MIRO_TEAM_ID;

interface APIGatewayProxyEventV2 {
  requestContext: {
    http: {
      method: string;
      path: string;
    };
    stage?: string;
    domainName?: string;
  };
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function extractMiroToken(event: APIGatewayProxyEventV2): string | null {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader) return null;
  return authHeader.replace(/^Bearer\s+/i, '').trim() || null;
}

async function buildBoardFilter(client: MiroClient): Promise<BoardFilterParams> {
  if (TEAM_ID) return { teamId: TEAM_ID };
  try {
    const tokenContext = await client.getTokenContext();
    return { ownerId: tokenContext.user.id };
  } catch {
    return {};
  }
}

function apiGatewayEventToRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }

  let body: string | undefined;
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
  }

  // Construct a URL — the host doesn't matter for routing, but Request requires a full URL
  const url = `https://localhost${event.requestContext.http.path}`;

  return new Request(url, {
    method,
    headers,
    body: method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' ? body : undefined,
  });
}

async function webResponseToApiGateway(response: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const body = await response.text();

  return {
    statusCode: response.status,
    headers,
    body,
  };
}

function deriveBaseUrl(event: APIGatewayProxyEventV2): string {
  const stage = event.requestContext.stage;
  const stagePrefix = stage && stage !== '$default' ? `/${stage}` : '';
  return `https://${event.requestContext.domainName}${stagePrefix}`;
}

function stripStagePrefix(event: APIGatewayProxyEventV2): string {
  const rawPath = event.requestContext.http.path;
  const stage = event.requestContext.stage;
  if (stage && stage !== '$default' && rawPath.startsWith(`/${stage}`)) {
    return rawPath.slice(`/${stage}`.length) || '/';
  }
  return rawPath;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const path = stripStagePrefix(event);
  const method = event.requestContext.http.method;
  const baseUrl = deriveBaseUrl(event);

  // --- OAuth discovery endpoints (no auth required) ---

  if (method === 'GET' && path === '/oauth/resource-metadata') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["boards:read", "boards:write"],
        resource_name: "Miro MCP Server",
      }),
    };
  }

  if (method === 'GET' && path === '/.well-known/openid-configuration') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: "https://miro.com/oauth/authorize",
        token_endpoint: "https://api.miro.com/v1/oauth/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        scopes_supported: ["boards:read", "boards:write"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      }),
    };
  }

  // --- MCP protocol (auth required) ---

  const miroToken = extractMiroToken(event);
  if (!miroToken) {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/oauth/resource-metadata"`,
      },
      body: JSON.stringify({ error: 'Unauthorized — Bearer token required' }),
    };
  }

  let miroClient: MiroClient;
  let boardFilter: BoardFilterParams;
  try {
    miroClient = new MiroClient(miroToken);
    boardFilter = await buildBoardFilter(miroClient);
  } catch (err: unknown) {
    console.error('[mcp-lambda] init error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Initialization failed' }),
    };
  }

  const server = new McpServer({
    name: "mcp-miro",
    version: VERSION,
  });

  registerMcpTools(server, miroClient, boardFilter, keyFactsContent);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,      // JSON response instead of SSE (Lambda-compatible)
  });

  await server.connect(transport);

  try {
    const request = apiGatewayEventToRequest(event);
    const response = await transport.handleRequest(request);
    return await webResponseToApiGateway(response);
  } catch (err: unknown) {
    console.error('[mcp-lambda] request error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
    };
  } finally {
    await transport.close();
    await server.close();
  }
};
