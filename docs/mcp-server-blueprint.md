# MCP Server Blueprint: Claude Desktop + ChatGPT Actions на AWS Lambda

Справочник для создания MCP-сервера, обслуживающего Claude Desktop (удалённый MCP Streamable HTTP) и ChatGPT (REST API + OpenAPI). Основан на production-проекте NetzSchule-Miro-MCP.

---

## Структура проекта

```
src/
├── ApiClient.ts          # Общий API-клиент (fetch, Bearer token)
├── schemas.ts            # Zod-схемы (shared между MCP и REST)
├── transforms.ts         # Трансформации ввода → формат API
├── index.ts              # Entry point: stdio (локальная разработка)
├── mcp/
│   ├── lambda.ts         # Entry point: MCP Lambda (Streamable HTTP + OAuth proxy)
│   └── registerTools.ts  # Регистрация MCP tools (transport-agnostic)
└── rest/
    ├── lambda.ts         # Entry point: REST Lambda
    ├── router.ts         # Pattern-based HTTP router
    └── handler.ts        # REST handlers (JSON responses)
openapi.json              # OpenAPI 3.1 spec для ChatGPT Actions
template.yaml             # AWS SAM (API Gateway + 2 Lambda)
```

---

## 1. Shared API Client

Не зависит от транспорта. Принимает Bearer token в конструкторе.

```typescript
export class ApiClient {
  constructor(private token: string) {}

  private async fetchApi(path: string, options?: RequestInit) {
    const res = await fetch(`https://api.example.com/v2${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  async listItems(limit: number, offset: number) { /* ... */ }
  async createItem(data: ItemData)               { /* ... */ }
}
```

---

## 2. MCP Lambda (Claude Desktop)

### Transport: stateless Streamable HTTP

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const handler = async (event: APIGatewayProxyEventV2) => {
  const path = stripStagePrefix(event);
  const method = event.requestContext.http.method;
  const baseUrl = deriveBaseUrl(event);

  // --- OAuth Discovery (без auth) ---

  if (method === 'GET' && path === '/oauth/resource-metadata') {
    return jsonResponse(200, {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: [],
    });
  }

  if (method === 'GET' && path === '/.well-known/openid-configuration') {
    return jsonResponse(200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  // --- OAuth Proxy ---

  if (method === 'POST' && path === '/oauth/register') {
    return jsonResponse(201, {
      client_id: `proxy-${Date.now()}`,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  }

  if (method === 'GET' && path === '/oauth/authorize') {
    const url = new URL('https://provider.com/oauth/authorize');
    for (const [k, v] of Object.entries(event.queryStringParameters || {})) {
      if (v) url.searchParams.set(k, v);
    }
    url.searchParams.set('client_id', process.env.CLIENT_ID!); // подмена
    return { statusCode: 302, headers: { Location: url.toString() }, body: '' };
  }

  if (method === 'POST' && path === '/oauth/token') {
    const params = new URLSearchParams(parseBody(event));
    params.set('client_id', process.env.CLIENT_ID!);
    params.set('client_secret', process.env.CLIENT_SECRET!);
    const res = await fetch('https://provider.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    let body = await res.text();
    // FIX: некоторые провайдеры возвращают expires_in: 0
    try {
      const data = JSON.parse(body);
      if (!data.expires_in) { data.expires_in = 31536000; body = JSON.stringify(data); }
    } catch {}
    return { statusCode: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body };
  }

  // --- MCP Protocol (auth required) ---

  const token = extractBearerToken(event);
  if (!token) {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/oauth/resource-metadata"`,
      },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const client = new ApiClient(token);
  const server = new McpServer({ name: "my-mcp", version: "1.0.0" });
  registerTools(server, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // JSON, не SSE
  });
  await server.connect(transport);

  try {
    const request = apiGatewayEventToRequest(event);
    const response = await transport.handleRequest(request);
    return await webResponseToApiGateway(response);
  } finally {
    await transport.close();
    await server.close();
  }
};
```

### Tool registration (transport-agnostic)

Эта же функция вызывается из stdio entry point для локальной разработки.

```typescript
export function registerTools(server: McpServer, client: ApiClient) {
  server.registerTool(
    "list_items",
    {
      description: "List items (paginated). Returns 20 most recent by default.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ limit, offset }) => {
      const result = await client.listItems(limit, offset);
      return {
        content: [
          { type: "text", text: `Showing ${result.data.length} of ${result.total}` },
          ...result.data.map(item => ({
            type: "text" as const,
            text: `ID: ${item.id}, Name: ${item.name}`,
          })),
        ],
      };
    }
  );
}
```

### Helpers: API Gateway ↔ Web Request

```typescript
function apiGatewayEventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) { if (v) headers.set(k, v); }
  let body: string | undefined;
  if (event.body) {
    body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  }
  const method = event.requestContext.http.method;
  return new Request(`https://localhost${event.requestContext.http.path}`, {
    method, headers,
    body: method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' ? body : undefined,
  });
}

async function webResponseToApiGateway(response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  return { statusCode: response.status, headers, body: await response.text() };
}

function stripStagePrefix(event: APIGatewayProxyEventV2): string {
  const path = event.requestContext.http.path;
  const stage = event.requestContext.stage;
  if (stage && stage !== '$default' && path.startsWith(`/${stage}`))
    return path.slice(`/${stage}`.length) || '/';
  return path;
}

function deriveBaseUrl(event: APIGatewayProxyEventV2): string {
  const stage = event.requestContext.stage;
  const prefix = stage && stage !== '$default' ? `/${stage}` : '';
  return `https://${event.requestContext.domainName}${prefix}`;
}

function extractBearerToken(event: APIGatewayProxyEventV2): string | null {
  const h = event.headers['authorization'] || event.headers['Authorization'];
  return h ? h.replace(/^Bearer\s+/i, '').trim() || null : null;
}

function jsonResponse(code: number, body: unknown) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
}
```

---

## 3. REST Lambda (ChatGPT Actions)

```typescript
export const handler = async (event: APIGatewayProxyEventV2) => {
  const token = extractBearerToken(event);
  if (!token) return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Unauthorized"}' };

  const client = new ApiClient(token);
  const path = stripStagePrefix(event);
  const route = matchRoute(event.requestContext.http.method, path);
  if (!route) return jsonResponse(404, { error: 'Not found' });

  try {
    switch (route.handler) {
      case 'listItems': {
        const limit = parseInt(event.queryStringParameters?.limit || '20') || 20;
        const items = await client.listItems(limit, 0);
        return jsonResponse(200, items); // ← JSON, не text content
      }
      case 'createItem': {
        const body = JSON.parse(parseBody(event));
        const item = await client.createItem(body);
        return jsonResponse(201, item);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    const code = msg.includes('404') ? 404 : msg.includes('403') ? 403 : 500;
    return jsonResponse(code, { error: msg });
  }
};
```

### Router

```typescript
function compileRoute(method: string, path: string, handler: string) {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; });
  return { method: method.toUpperCase(), pattern: new RegExp(`^${pattern}$`), paramNames, handler };
}

const routes = [
  compileRoute('GET',  '/items',         'listItems'),
  compileRoute('POST', '/items',         'createItem'),
  compileRoute('GET',  '/items/:itemId', 'getItem'),
];

export function matchRoute(method: string, path: string) {
  for (const r of routes) {
    if (r.method !== method.toUpperCase()) continue;
    const m = path.match(r.pattern);
    if (m) {
      const params: Record<string, string> = {};
      r.paramNames.forEach((n, i) => { params[n] = m[i + 1]; });
      return { handler: r.handler, params };
    }
  }
  return null;
}
```

---

## 4. OpenAPI Spec (для ChatGPT Actions)

```json
{
  "openapi": "3.1.0",
  "info": { "title": "My API", "version": "1.0.0" },
  "servers": [{ "url": "https://xxx.execute-api.region.amazonaws.com/prod" }],
  "paths": {
    "/items": {
      "get": {
        "operationId": "listItems",
        "summary": "List items",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 20, "maximum": 50 } }
        ],
        "responses": { "200": { "description": "OK", "content": { "application/json": { "schema": { "type": "object" } } } } }
      },
      "post": {
        "operationId": "createItem",
        "summary": "Create an item",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["name"],
            "properties": {
              "name": { "type": "string" },
              "color": { "type": "string", "enum": ["red", "blue", "green"], "default": "blue" }
            }
          }}}
        },
        "responses": { "201": { "description": "Created" } }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "OAuth": {
        "type": "oauth2",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": "https://xxx.../oauth/authorize",
            "tokenUrl": "https://xxx.../oauth/token",
            "scopes": {}
          }
        }
      }
    }
  },
  "security": [{ "OAuth": [] }]
}
```

**Правила для ChatGPT:**
- Каждый path — уникальный `operationId`
- `enum` и `default` для всех параметров с фиксированным набором значений
- Плоские структуры лучше вложенных (ChatGPT реже ошибается)
- `description` на уровне path, не в каждом поле schema

---

## 5. SAM Template

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Timeout: 30
    Runtime: nodejs24.x
    MemorySize: 256

Parameters:
  ClientId:
    Type: String
  ClientSecret:
    Type: String
    NoEcho: true

Resources:
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod
      CorsConfiguration:
        AllowOrigins: ["*"]
        AllowMethods: [GET, POST, PATCH, DELETE, OPTIONS]
        AllowHeaders: [Authorization, Content-Type]

  RestFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: lambda.handler
      CodeUri: dist/
      AutoPublishAlias: live
      ReservedConcurrentExecutions: 50
      Events:
        ListItems:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /items, Method: GET }
        CreateItem:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /items, Method: POST }

  McpFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: mcp-lambda.handler
      CodeUri: dist/
      AutoPublishAlias: live
      ReservedConcurrentExecutions: 50
      Environment:
        Variables:
          CLIENT_ID: !Ref ClientId
          CLIENT_SECRET: !Ref ClientSecret
      Events:
        McpPost:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /mcp, Method: POST }
        McpGet:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /mcp, Method: GET }
        McpDelete:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /mcp, Method: DELETE }
        ResourceMetadata:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /oauth/resource-metadata, Method: GET }
        OidcDiscovery:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /.well-known/openid-configuration, Method: GET }
        OAuthRegister:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /oauth/register, Method: POST }
        OAuthAuthorize:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /oauth/authorize, Method: GET }
        OAuthToken:
          Type: HttpApi
          Properties: { ApiId: !Ref HttpApi, Path: /oauth/token, Method: POST }
```

---

## 6. Build Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "build:lambda": "esbuild src/rest/lambda.ts --bundle --platform=node --target=node24 --outfile=dist/lambda.js --format=cjs",
    "build:mcp-lambda": "esbuild src/mcp/lambda.ts --bundle --platform=node --target=node24 --outfile=dist/mcp-lambda.js --format=cjs",
    "build:lambdas": "npm run build:lambda && npm run build:mcp-lambda",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "zod": "^4.0.0"
  }
}
```

---

## 7. Ключевые правила

| Правило | Почему |
|---------|--------|
| `sessionIdGenerator: undefined` | Stateless — без DynamoDB для сессий |
| `enableJsonResponse: true` | API Gateway буферизует ответы, SSE не работает |
| Fresh McpServer per request | Изоляция пользователей (разные Bearer tokens) |
| `transport.close()` + `server.close()` в `finally` | Lambda reuse может leak state |
| OAuth proxy: подмена `client_id`, инжекция `client_secret` | Secrets остаются на сервере |
| `WWW-Authenticate: Bearer resource_metadata="..."` в 401 | Триггер OAuth flow в Claude Desktop |
| Fix `expires_in: 0` → `31536000` в token proxy | Claude Desktop считает 0 = expired |
| CORS на всех ответах включая ошибки | ChatGPT вызывает из браузера |
| `stripStagePrefix()` | API Gateway V2 добавляет `/prod` в path |
| Base64 decode: проверять `isBase64Encoded` | API Gateway V2 может кодировать body |
| MCP tools → text content, REST → JSON | Каждый клиент лучше работает со своим форматом |
| `registerTools()` в отдельном файле | Один код для stdio + Lambda |
| Два Lambda, один API Gateway | Разные deps, env vars, масштабирование |
| `ReservedConcurrentExecutions` | Защита от runaway costs |
