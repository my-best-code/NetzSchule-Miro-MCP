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

const API_KEY = process.env.REST_API_KEY;
const MIRO_TOKEN = process.env.MIRO_OAUTH_TOKEN;
const TEAM_ID = process.env.MIRO_TEAM_ID;

let miroClient: MiroClient | null = null;
let boardFilter: BoardFilterParams = {};
let initialized = false;

async function init() {
  if (initialized) return;
  if (!MIRO_TOKEN) throw new Error('MIRO_OAUTH_TOKEN environment variable is required');

  miroClient = new MiroClient(MIRO_TOKEN);

  if (TEAM_ID) {
    boardFilter = { teamId: TEAM_ID };
  } else {
    try {
      const tokenContext = await miroClient.getTokenContext();
      boardFilter = { ownerId: tokenContext.user.id };
    } catch {
      // If auto-detect fails, show all boards
    }
  }

  initialized = true;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Auth check
  if (API_KEY) {
    const authHeader = event.headers['authorization'] || event.headers['Authorization'];
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (token !== API_KEY) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }
  }

  try {
    await init();
  } catch (err: unknown) {
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

  return handleRequest(req, miroClient!, boardFilter);
};
