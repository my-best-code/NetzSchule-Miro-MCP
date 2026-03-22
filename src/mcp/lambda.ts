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
const MIRO_CLIENT_ID = process.env.MIRO_CLIENT_ID;
const MIRO_CLIENT_SECRET = process.env.MIRO_CLIENT_SECRET;

// --- Types ---

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
  queryStringParameters?: Record<string, string | undefined>;
}

interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// --- Helpers ---

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

function jsonResponse(statusCode: number, body: unknown, extraHeaders?: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function parseRequestBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
}

// --- Handler ---

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const path = stripStagePrefix(event);
  const method = event.requestContext.http.method;
  const baseUrl = deriveBaseUrl(event);

  console.log('[mcp] request', method, path);

  // =============================================
  // OAuth Discovery (no auth required)
  // =============================================

  // Protected Resource Metadata (RFC 9728)
  if (method === 'GET' && path === '/oauth/resource-metadata') {
    const body = {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: [],
      resource_name: "Miro MCP Server",
    };
    console.log('[mcp] resource-metadata response', JSON.stringify(body));
    return jsonResponse(200, body);
  }

  // OIDC Discovery — authorization server metadata
  if (method === 'GET' && path === '/.well-known/openid-configuration') {
    const body = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      scopes_supported: [],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    };
    console.log('[mcp] oidc-discovery response', JSON.stringify(body));
    return jsonResponse(200, body);
  }

  // =============================================
  // OAuth Proxy — Dynamic Client Registration (RFC 7591)
  // =============================================

  // POST /oauth/register — returns a proxy client_id (real Miro credentials are server-side)
  if (method === 'POST' && path === '/oauth/register') {
    const rawBody = parseRequestBody(event);
    console.log('[mcp] /oauth/register request:', rawBody);

    let registrationRequest: Record<string, unknown> = {};
    try {
      registrationRequest = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      // ignore parse errors
    }

    const clientId = `mcp-miro-proxy-${Date.now()}`;
    const response = {
      client_id: clientId,
      client_name: (registrationRequest.client_name as string) || 'MCP Client',
      redirect_uris: registrationRequest.redirect_uris || [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };

    console.log('[mcp] /oauth/register response:', JSON.stringify(response));
    return jsonResponse(201, response);
  }

  // =============================================
  // OAuth Proxy — authorization endpoint
  // =============================================

  // GET /oauth/authorize — redirect to Miro with injected client_id
  if (method === 'GET' && path === '/oauth/authorize') {
    if (!MIRO_CLIENT_ID) {
      console.error('[mcp] MIRO_CLIENT_ID not configured');
      return jsonResponse(500, { error: 'OAuth not configured: MIRO_CLIENT_ID missing' });
    }

    const qs = event.queryStringParameters || {};
    console.log('[mcp] /oauth/authorize query params', JSON.stringify(qs));

    // Build Miro authorization URL, replacing client_id with ours
    const miroAuthUrl = new URL('https://miro.com/oauth/authorize');
    // Forward all query params from the client
    for (const [key, value] of Object.entries(qs)) {
      if (value !== undefined) {
        miroAuthUrl.searchParams.set(key, value);
      }
    }
    // Override client_id with our server-side value
    miroAuthUrl.searchParams.set('client_id', MIRO_CLIENT_ID);

    const redirectUrl = miroAuthUrl.toString();
    console.log('[mcp] redirecting to Miro:', redirectUrl);

    return {
      statusCode: 302,
      headers: {
        'Location': redirectUrl,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  }

  // =============================================
  // OAuth Proxy — token endpoint
  // =============================================

  // POST /oauth/token — proxy token exchange to Miro
  if (method === 'POST' && path === '/oauth/token') {
    if (!MIRO_CLIENT_ID || !MIRO_CLIENT_SECRET) {
      console.error('[mcp] MIRO_CLIENT_ID or MIRO_CLIENT_SECRET not configured');
      return jsonResponse(500, { error: 'OAuth not configured: missing Miro credentials' });
    }

    const rawBody = parseRequestBody(event);
    console.log('[mcp] /oauth/token request body:', rawBody);

    // Parse the incoming form-encoded body
    const params = new URLSearchParams(rawBody);

    // Inject our server-side Miro credentials
    params.set('client_id', MIRO_CLIENT_ID);
    params.set('client_secret', MIRO_CLIENT_SECRET);

    const miroTokenUrl = 'https://api.miro.com/v1/oauth/token';
    const forwardBody = params.toString();
    console.log('[mcp] forwarding to Miro token endpoint:', miroTokenUrl);
    console.log('[mcp] forward body (redacted secret):', forwardBody.replace(/client_secret=[^&]+/, 'client_secret=***'));

    try {
      const miroResponse = await fetch(miroTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: forwardBody,
      });

      const miroResponseBody = await miroResponse.text();
      console.log('[mcp] Miro token response status:', miroResponse.status);
      console.log('[mcp] Miro token response body:', miroResponseBody);

      // Fix Miro's expires_in: 0 — Claude interprets 0 as "already expired"
      // Miro tokens are long-lived, so we set a reasonable TTL
      let fixedBody = miroResponseBody;
      if (miroResponse.ok) {
        try {
          const tokenData = JSON.parse(miroResponseBody);
          if (tokenData.expires_in === 0 || !tokenData.expires_in) {
            tokenData.expires_in = 3600; // 1 hour
            console.log('[mcp] fixed expires_in: 0 → 3600');
          }
          fixedBody = JSON.stringify(tokenData);
        } catch {
          // keep original body if parse fails
        }
      }

      const responseHeaders: Record<string, string> = {
        'Content-Type': miroResponse.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      };

      return {
        statusCode: miroResponse.status,
        headers: responseHeaders,
        body: fixedBody,
      };
    } catch (err: unknown) {
      console.error('[mcp] Miro token exchange error:', err);
      return jsonResponse(502, {
        error: 'Token exchange with Miro failed',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // =============================================
  // MCP Protocol (auth required)
  // =============================================

  const miroToken = extractMiroToken(event);
  if (!miroToken) {
    console.log('[mcp] 401 — no Bearer token');
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/oauth/resource-metadata"`,
      },
      body: JSON.stringify({ error: 'Unauthorized — Bearer token required' }),
    };
  }

  console.log('[mcp] Bearer token present, initializing MiroClient');

  let miroClient: MiroClient;
  let boardFilter: BoardFilterParams;
  try {
    miroClient = new MiroClient(miroToken);
    boardFilter = await buildBoardFilter(miroClient);
  } catch (err: unknown) {
    console.error('[mcp] init error', err);
    return jsonResponse(500, { error: err instanceof Error ? err.message : 'Initialization failed' });
  }

  const server = new McpServer({
    name: "mcp-miro",
    version: VERSION,
  });

  registerMcpTools(server, miroClient, boardFilter, keyFactsContent);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const request = apiGatewayEventToRequest(event);
    const response = await transport.handleRequest(request);
    return await webResponseToApiGateway(response);
  } catch (err: unknown) {
    console.error('[mcp] request error', err);
    return jsonResponse(500, { error: err instanceof Error ? err.message : 'Internal server error' });
  } finally {
    await transport.close();
    await server.close();
  }
};
