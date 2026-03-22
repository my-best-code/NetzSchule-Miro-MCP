import { MiroClient, type BoardFilterParams } from "../MiroClient.js";
import { handleRequest, type HttpRequest } from "./handler.js";

interface APIGatewayProxyEventV2 {
  requestContext: {
    http: {
      method: string;
      path: string;
    };
    stage?: string;
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

const TEAM_ID = process.env.MIRO_TEAM_ID;

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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Extract Miro OAuth token from Authorization header (provided by ChatGPT OAuth flow)
  const miroToken = extractMiroToken(event);
  if (!miroToken) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized — Bearer token required' }),
    };
  }

  let miroClient: MiroClient;
  let boardFilter: BoardFilterParams;
  try {
    console.log('[lambda] init start');
    miroClient = new MiroClient(miroToken);
    boardFilter = await buildBoardFilter(miroClient);
    console.log('[lambda] init done');
  } catch (err: unknown) {
    console.error('[lambda] init error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Initialization failed' }),
    };
  }

  let body: unknown;
  if (event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : event.body;
      body = JSON.parse(raw);
    } catch {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }
  }

  // API Gateway v2 includes the stage prefix (e.g. /prod) in the path — strip it for routing
  const rawPath = event.requestContext.http.path;
  const stage = event.requestContext?.stage;
  const path = stage && stage !== '$default' && rawPath.startsWith(`/${stage}`)
    ? rawPath.slice(`/${stage}`.length) || '/'
    : rawPath;

  const req: HttpRequest = {
    method: event.requestContext.http.method,
    path,
    headers: event.headers as Record<string, string | undefined>,
    body,
    queryStringParameters: event.queryStringParameters,
  };

  console.log('[lambda] handleRequest', req.method, req.path);
  const result = await handleRequest(req, miroClient, boardFilter);
  console.log('[lambda] response', result.statusCode);
  return result;
};
