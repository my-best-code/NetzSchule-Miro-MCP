# Stateless HTTP Streamable MCP-серверы на AWS Lambda

Практическое руководство по развертыванию MCP-серверов в serverless-среде.
Основано на production-проекте [NetzSchule-Miro-MCP](https://github.com/my-best-code/NetzSchule-Miro-MCP).

**Стек:** MCP SDK 1.27+, TypeScript, AWS Lambda (Node.js 24), API Gateway V2 (HTTP API), esbuild, SAM.

---

## Содержание

1. [Почему Stateless HTTP Streamable](#1-почему-stateless-http-streamable)
2. [Настройка транспорта](#2-настройка-транспорта)
3. [Жизненный цикл запроса](#3-жизненный-цикл-запроса)
4. [Адаптер API Gateway ↔ Web Request](#4-адаптер-api-gateway--web-request)
5. [OAuth-прокси паттерн](#5-oauth-прокси-паттерн)
6. [Инфраструктура (SAM)](#6-инфраструктура-sam)
7. [Подводные камни](#7-подводные-камни)
8. [Сборка и производительность](#8-сборка-и-производительность)
9. [Двойной режим: stdio + Lambda](#9-двойной-режим-stdio--lambda)
10. [Тестирование](#10-тестирование)

---

## 1. Почему Stateless HTTP Streamable

MCP изначально проектировался для stdio и SSE/WebSocket — транспортов, подразумевающих persistent connection. Lambda так не работает: каждый вызов — это отдельный HTTP request-response цикл.

**Streamable HTTP** — транспорт из MCP SDK 1.18+, который решает эту проблему:

| Критерий | SSE / WebSocket | Stateless Streamable HTTP |
|----------|----------------|---------------------------|
| Lambda-совместимость | Нет (нужен persistent connection) | Да (стандартный HTTP) |
| API Gateway | Только WebSocket API | HTTP API (V2) |
| Хранение сессий | DynamoDB / ElastiCache | Не нужно |
| Горизонтальное масштабирование | Sticky sessions | Автоматическое |
| Стоимость | Idle-серверы | Pay-per-invocation |

**Ключевой принцип:** каждый Lambda-вызов полностью независим — создает свой экземпляр `McpServer`, обрабатывает запрос и уничтожается. Нет shared state, нет сессий, нет проблем с конкурентностью.

---

## 2. Настройка транспорта

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,  // stateless — без отслеживания сессий
  enableJsonResponse: true,       // JSON вместо SSE-потока
});

await server.connect(transport);
```

### Что делают параметры

**`sessionIdGenerator: undefined`** — выключает сессии полностью:
- SDK не создает `Mcp-Session-Id` header
- SDK не отклоняет запросы без session ID
- Каждый запрос обрабатывается независимо

Альтернатива — `() => randomUUID()`, но тогда нужно хранилище сессий (DynamoDB), что противоречит serverless-философии.

**`enableJsonResponse: true`** — ответы возвращаются как обычные JSON-объекты, а не SSE event streams. Это критично для API Gateway, который буферизует ответы целиком перед отправкой клиенту.

### Важно: Web Standard вариант

Используется именно `WebStandardStreamableHTTPServerTransport` (не `StreamableHTTPServerTransport`). Эта версия работает с Web `Request`/`Response` объектами, которые поддерживает Lambda runtime Node.js 18+.

---

## 3. Жизненный цикл запроса

Каждый вызов Lambda создает полный стек MCP-сервера с нуля:

```typescript
export const handler = async (event: APIGatewayProxyEventV2) => {
  // 1. Извлечь Bearer token
  const token = extractBearerToken(event);
  if (!token) return unauthorized(event);

  // 2. Создать клиент API с токеном пользователя
  const apiClient = new ApiClient(token);

  // 3. Создать MCP-сервер
  const server = new McpServer({ name: "my-mcp", version: "1.0.0" });

  // 4. Зарегистрировать инструменты (transport-agnostic)
  registerTools(server, apiClient);

  // 5. Создать транспорт и подключить
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // 6. Обработать запрос
  try {
    const request = apiGatewayEventToRequest(event);
    const response = await transport.handleRequest(request);
    return await webResponseToApiGateway(response);
  } catch (err) {
    return errorResponse(500, err);
  } finally {
    // 7. ОБЯЗАТЕЛЬНО: очистка в finally
    await transport.close();
    await server.close();
  }
};
```

### Почему fresh server per request

- **Изоляция пользователей.** Контекст MCP-сервера (зарегистрированные инструменты, клиент API) привязан к Bearer token конкретного пользователя. Переиспользование сервера = утечка состояния между пользователями.
- **Lambda reuse.** AWS может переиспользовать execution environment между вызовами. Без пересоздания сервера предыдущий пользователь «наследуется» следующему.
- **Cleanup в `finally`.** И `transport.close()`, и `server.close()` вызываются даже при ошибках. Без этого — утечки ресурсов при повторном использовании Lambda container.

---

## 4. Адаптер API Gateway ↔ Web Request

MCP SDK работает с Web Standard `Request`/`Response`. Lambda получает `APIGatewayProxyEventV2`. Нужен адаптерный слой.

### Event → Request

```typescript
function apiGatewayEventToRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;

  // Headers
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }

  // Body — может быть base64-encoded
  let body: string | undefined;
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
  }

  // URL — MCP SDK использует только path, host не важен
  const url = `https://localhost${event.requestContext.http.path}`;

  return new Request(url, {
    method,
    headers,
    // Body только для методов, которые его поддерживают
    body: method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
      ? body : undefined,
  });
}
```

### Response → API Gateway Result

```typescript
async function webResponseToApiGateway(
  response: Response
): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}
```

### Stage prefix

API Gateway V2 с именованным stage (например, `prod`) добавляет `/<stage>` в path. Нужно убирать перед роутингом:

```typescript
function stripStagePrefix(event: APIGatewayProxyEventV2): string {
  const rawPath = event.requestContext.http.path;
  const stage = event.requestContext.stage;
  if (stage && stage !== '$default' && rawPath.startsWith(`/${stage}`)) {
    return rawPath.slice(`/${stage}`.length) || '/';
  }
  return rawPath;
}
```

### Base URL для OAuth discovery

```typescript
function deriveBaseUrl(event: APIGatewayProxyEventV2): string {
  const stage = event.requestContext.stage;
  const stagePrefix = stage && stage !== '$default' ? `/${stage}` : '';
  return `https://${event.requestContext.domainName}${stagePrefix}`;
}
```

---

## 5. OAuth-прокси паттерн

MCP-клиенты (Claude Desktop, Claude Code) аутентифицируются через OAuth. Но client_secret нельзя хранить на стороне клиента. Решение — Lambda выступает OAuth-прокси.

### Поток аутентификации

```
MCP Client                Lambda (OAuth Proxy)              External API (Miro)
    │                            │                                │
    │── GET /oauth/resource-     │                                │
    │   metadata ───────────────>│                                │
    │<── { resource, auth_       │                                │
    │     servers } ─────────────│                                │
    │                            │                                │
    │── GET /.well-known/        │                                │
    │   openid-configuration ──>│                                │
    │<── { endpoints } ─────────│                                │
    │                            │                                │
    │── POST /oauth/register ──>│                                │
    │<── { proxy_client_id } ───│                                │
    │                            │                                │
    │── GET /oauth/authorize ──>│                                │
    │<── 302 → Miro authorize ──│── (подменяет client_id) ──────>│
    │                            │                                │
    │── POST /oauth/token ─────>│── (инжектирует client_id +     │
    │                            │   client_secret) ────────────>│
    │<── { access_token } ──────│<── { access_token } ──────────│
    │                            │                                │
    │── POST /mcp ──────────────│── Bearer token ──────────────>│
    │   Authorization: Bearer    │                                │
```

### Эндпоинты

#### 1. Protected Resource Metadata (RFC 9728)

```typescript
// GET /oauth/resource-metadata
if (method === 'GET' && path === '/oauth/resource-metadata') {
  return jsonResponse(200, {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: [],
    resource_name: "My MCP Server",
  });
}
```

Этот эндпоинт сообщает клиенту, где находится авторизационный сервер. URL возвращается в 401-ответе через `WWW-Authenticate` header.

#### 2. OIDC Discovery

```typescript
// GET /.well-known/openid-configuration
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
```

#### 3. Dynamic Client Registration (RFC 7591)

```typescript
// POST /oauth/register — выдает прокси client_id
const clientId = `mcp-proxy-${Date.now()}`;
return jsonResponse(201, {
  client_id: clientId,
  grant_types: ["authorization_code"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
});
```

Client ID — эфемерный идентификатор. Реальные credentials хранятся в env vars Lambda.

#### 4. Authorization redirect

```typescript
// GET /oauth/authorize — перенаправляет на внешний API
const authUrl = new URL('https://api.example.com/oauth/authorize');
// Пробрасываем query params от клиента...
for (const [key, value] of Object.entries(queryParams)) {
  if (value) authUrl.searchParams.set(key, value);
}
// ...но подменяем client_id на серверный
authUrl.searchParams.set('client_id', process.env.CLIENT_ID!);

return { statusCode: 302, headers: { Location: authUrl.toString() }, body: '' };
```

#### 5. Token exchange proxy

```typescript
// POST /oauth/token — проксирует обмен кода на токен
const params = new URLSearchParams(requestBody);
params.set('client_id', process.env.CLIENT_ID!);
params.set('client_secret', process.env.CLIENT_SECRET!);

const response = await fetch('https://api.example.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params.toString(),
});
```

#### 6. 401 с WWW-Authenticate

Когда MCP-запрос приходит без Bearer token:

```typescript
return {
  statusCode: 401,
  headers: {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/oauth/resource-metadata"`,
  },
  body: JSON.stringify({ error: 'Unauthorized — Bearer token required' }),
};
```

Клиент (Claude Desktop) получает 401, извлекает URL resource-metadata, и запускает OAuth flow.

---

## 6. Инфраструктура (SAM)

### Минимальный template.yaml

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Timeout: 30          # API Gateway hard limit
    Runtime: nodejs24.x
    MemorySize: 256

Parameters:
  ClientId:
    Type: String
  ClientSecret:
    Type: String
    NoEcho: true         # Не показывать в CloudFormation console

Resources:
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod
      CorsConfiguration:
        AllowOrigins: ["*"]
        AllowMethods: [GET, POST, DELETE, OPTIONS]
        AllowHeaders: [Authorization, Content-Type]

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
        # MCP Protocol
        McpPost:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /mcp
            Method: POST
        McpGet:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /mcp
            Method: GET
        McpDelete:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /mcp
            Method: DELETE
        # OAuth Discovery
        ResourceMetadata:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /oauth/resource-metadata
            Method: GET
        OidcDiscovery:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /.well-known/openid-configuration
            Method: GET
        # OAuth Proxy
        OAuthRegister:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /oauth/register
            Method: POST
        OAuthAuthorize:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /oauth/authorize
            Method: GET
        OAuthToken:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /oauth/token
            Method: POST

Outputs:
  McpUrl:
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/prod/mcp"
```

### Ключевые настройки

- **`ReservedConcurrentExecutions: 50`** — ограничивает количество одновременных вызовов. Защита от DDoS и runaway costs. Также гарантирует доступность этих 50 инстансов.
- **`AutoPublishAlias: live`** — безопасные деплои через Lambda aliases.
- **`NoEcho: true`** — для секретов (client_secret не виден в CloudFormation console).
- **`Timeout: 30`** — API Gateway HTTP API имеет hard limit 30 секунд. Lambda timeout должен совпадать.
- **CORS** — `AllowHeaders` должен включать `Authorization` и `Content-Type`.

---

## 7. Подводные камни

### 7.1 Баг `expires_in: 0`

Некоторые API (Miro) возвращают `expires_in: 0` в token response. Claude Desktop интерпретирует это как «токен уже истек» и сразу пытается обновить, создавая бесконечный цикл.

**Решение** — исправить в прокси:

```typescript
const tokenData = JSON.parse(responseBody);
if (tokenData.expires_in === 0 || !tokenData.expires_in) {
  tokenData.expires_in = 31536000; // 1 год
}
```

### 7.2 CORS на ошибках

CORS-заголовки нужны **на всех ответах**, включая 401, 500 и другие ошибки. Иначе браузерный клиент не увидит даже сообщение об ошибке.

```typescript
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',  // Всегда!
    },
    body: JSON.stringify(body),
  };
}
```

### 7.3 Base64-encoded body

API Gateway V2 может отправить body в base64. Нужно проверять флаг `isBase64Encoded` в **двух местах**: при конвертации event в Request и при парсинге body для OAuth endpoints.

### 7.4 Stage prefix в paths

API Gateway V2 с named stage (например, `prod`) включает `/<stage>` в `requestContext.http.path`. Если не убрать — роутинг сломается: вместо `/mcp` придет `/prod/mcp`.

### 7.5 DELETE /mcp

MCP-спецификация требует поддержки `DELETE /mcp` для завершения сессий. В stateless режиме это no-op, но роут всё равно нужен — иначе клиент получит 404.

### 7.6 Cold starts

Бандл MCP-сервера ~1.1 MB. Node.js 24 runtime с 256MB RAM: cold start ~300-500ms. Под нагрузкой reserved concurrency держит инстансы warm.

### 7.7 Timeout 30 секунд

API Gateway HTTP API — hard limit. Если MCP-инструмент вызывает внешний API с пагинацией или множественными запросами, можно упереться. Мониторьте длительность инструментов.

---

## 8. Сборка и производительность

### esbuild для Lambda

```bash
esbuild src/mcp/lambda.ts \
  --bundle \
  --platform=node \
  --target=node24 \
  --outfile=dist/mcp-lambda.js \
  --format=cjs \
  --loader:.md=text
```

| Флаг | Зачем |
|------|-------|
| `--bundle` | Один файл, без node_modules в deployment package |
| `--platform=node` | Node.js built-ins не бандлятся |
| `--format=cjs` | Lambda ожидает `exports.handler` |
| `--target=node24` | Современный JS без лишней транспиляции |
| `--loader:.md=text` | Markdown-ресурсы инлайнятся как строки |

**Результат:** ~1.1 MB вместо ~100 MB с node_modules.

### Dual build стратегия

```json
{
  "scripts": {
    "build": "tsc",                    // Для stdio и npm package
    "build:mcp-lambda": "esbuild ...", // Для Lambda
    "build:lambdas": "npm run build:lambda && npm run build:mcp-lambda"
  }
}
```

`tsc` создает `build/` для локального режима (stdio) и npm-публикации. `esbuild` создает `dist/` для Lambda-деплоя. Один исходный код — две цели.

### Memory sizing

- **256 MB** — достаточно для типичных MCP-серверов (API proxying, JSON transforms)
- Больше памяти = больше CPU (Lambda распределяет CPU пропорционально)
- Для compute-heavy инструментов (обработка изображений, парсинг документов) — 512-1024 MB

---

## 9. Двойной режим: stdio + Lambda

Ключевой паттерн — вынести регистрацию инструментов в transport-agnostic функцию:

```typescript
// registerTools.ts — не зависит от транспорта
export function registerTools(
  server: McpServer,
  apiClient: ApiClient,
  config: Config,
) {
  server.registerTool("list_items", { ... }, async (params) => {
    return await apiClient.listItems(params);
  });

  server.registerTool("create_item", { ... }, async (params) => {
    return await apiClient.createItem(params);
  });
}
```

Эта же функция вызывается из обоих entrypoints:

```typescript
// index.ts — stdio (локальная разработка)
const server = new McpServer({ name: "my-mcp", version });
const client = new ApiClient(token);
registerTools(server, client, config);
const transport = new StdioServerTransport();
await server.connect(transport);
```

```typescript
// lambda.ts — Streamable HTTP (production)
const server = new McpServer({ name: "my-mcp", version });
const client = new ApiClient(bearerToken);
registerTools(server, client, config);
const transport = new WebStandardStreamableHTTPServerTransport({ ... });
await server.connect(transport);
// ... handle request, cleanup
```

**Преимущества:**
- Быстрая итерация локально через stdio + MCP Inspector
- Production-деплой через Lambda без изменения бизнес-логики
- Тестирование инструментов без транспортного слоя

---

## 10. Тестирование

### Unit-тесты (Vitest)

Тестируйте API-клиент и бизнес-логику отдельно от транспорта:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Мок fetch глобально
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ApiClient', () => {
  it('passes auth header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const client = new ApiClient('test-token');
    await client.listItems();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});
```

### MCP Inspector

Для stdio-режима:

```bash
npx @modelcontextprotocol/inspector build/index.js
```

Для remote-режима — указать URL развернутого сервера в Inspector UI.

### SAM Local

```bash
# Локальный запуск Lambda
sam local invoke MiroMcpFunction -e test-event.json

# Локальный API
sam local start-api
```

### Проверка OAuth curl-ом

```bash
BASE=https://xxx.execute-api.eu-central-1.amazonaws.com/prod

# Resource metadata
curl $BASE/oauth/resource-metadata | jq

# OIDC discovery
curl $BASE/.well-known/openid-configuration | jq

# Registration
curl -X POST $BASE/oauth/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"test"}' | jq

# MCP без токена → 401 + WWW-Authenticate
curl -v $BASE/mcp 2>&1 | grep WWW-Authenticate
```

---

## Чеклист для нового проекта

- [ ] `WebStandardStreamableHTTPServerTransport` с `sessionIdGenerator: undefined`
- [ ] `enableJsonResponse: true`
- [ ] Создание McpServer + transport per request
- [ ] Cleanup в `finally` блоке (`transport.close()`, `server.close()`)
- [ ] Адаптер API Gateway ↔ Web Request с обработкой base64 и stage prefix
- [ ] OAuth-прокси: resource-metadata, OIDC discovery, register, authorize, token
- [ ] 401 с `WWW-Authenticate: Bearer resource_metadata="..."`
- [ ] CORS headers на всех ответах, включая ошибки
- [ ] esbuild bundle в single file
- [ ] `ReservedConcurrentExecutions` для защиты от runaway costs
- [ ] Transport-agnostic `registerTools()` для dual mode (stdio + Lambda)
- [ ] Unit-тесты с mock fetch
