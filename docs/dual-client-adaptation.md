# Адаптация MCP-сервера для Claude Desktop и ChatGPT Actions

Практическое руководство по созданию единого бэкенда, который одновременно обслуживает
**Claude Desktop** (через удалённый MCP Streamable HTTP) и **ChatGPT** (через REST API + OpenAPI spec).

Основано на production-проекте [NetzSchule-Miro-MCP](https://github.com/my-best-code/NetzSchule-Miro-MCP).

---

## Содержание

1. [Архитектура: два интерфейса — один бэкенд](#1-архитектура-два-интерфейса--один-бэкенд)
2. [Общий слой: API-клиент, схемы, трансформации](#2-общий-слой-api-клиент-схемы-трансформации)
3. [Claude Desktop: удалённый MCP-сервер](#3-claude-desktop-удалённый-mcp-сервер)
4. [ChatGPT Actions: REST API + OpenAPI](#4-chatgpt-actions-rest-api--openapi)
5. [OAuth: одна авторизация — два клиента](#5-oauth-одна-авторизация--два-клиента)
6. [Различия в форматах ответов](#6-различия-в-форматах-ответов)
7. [OpenAPI-спецификация для GPT Actions](#7-openapi-спецификация-для-gpt-actions)
8. [Инфраструктура: два Lambda на одном API Gateway](#8-инфраструктура-два-lambda-на-одном-api-gateway)
9. [Подводные камни и workarounds](#9-подводные-камни-и-workarounds)
10. [Чеклист для адаптации](#10-чеклист-для-адаптации)

---

## 1. Архитектура: два интерфейса — один бэкенд

```
Claude Desktop                     ChatGPT (Custom GPT)
     │                                   │
     │ MCP Protocol                      │ REST API
     │ (JSON-RPC over HTTP)              │ (JSON over HTTP)
     │                                   │
     │ POST /mcp                         │ GET /boards
     │ + OAuth proxy endpoints           │ POST /boards/:id/sticky-notes
     │                                   │ ...
     │                                   │
     ▼                                   ▼
┌──────────────┐               ┌──────────────────┐
│ MCP Lambda   │               │  REST Lambda      │
│ (mcp-lambda) │               │  (lambda)         │
└──────┬───────┘               └────────┬──────────┘
       │                                │
       │  registerTools()               │  handleRequest()
       │  (Zod schemas,                 │  (router + handlers,
       │   text responses)              │   JSON responses)
       │                                │
       └──────────┬─────────────────────┘
                  │
          ┌───────┴──────────┐
          │   MiroClient     │  ← shared business logic
          │   schemas.ts     │
          │   transforms.ts  │
          └──────────────────┘
                  │
              Miro API v2
```

**Принцип:** бизнес-логика (API-клиент, валидация, трансформации) — общая.
Два интерфейса — это тонкие адаптерные слои, каждый со своим форматом ввода/вывода.

---

## 2. Общий слой: API-клиент, схемы, трансформации

### API-клиент (`MiroClient.ts`)

Единый класс для работы с внешним API. Не зависит от транспорта — работает с любым Bearer token:

```typescript
export class MiroClient {
  constructor(private token: string) {}

  private async fetchApi(path: string, options?: RequestInit) {
    const response = await fetch(`https://api.miro.com/v2${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!response.ok) throw new Error(`Miro API error: ${response.status}`);
    return response.json();
  }

  async getBoardsPage(filter, limit, offset) { /* ... */ }
  async createStickyNote(boardId, data)       { /* ... */ }
  async getFrames(boardId)                    { /* ... */ }
  // ... все методы API
}
```

### Схемы валидации (`schemas.ts`)

Zod-схемы, используемые обоими интерфейсами:

```typescript
export const createStickyNoteSchema = {
  boardId: z.string(),
  content: z.string(),
  color: z.enum(stickyNoteColors).default("yellow"),
  size: z.enum(stickySizeNames).optional(),
  // ...
};
```

- **MCP** использует Zod-схемы напрямую как `inputSchema` в `registerTool()`
- **REST** использует те же константы (`stickyNoteColors`, `shapeTypes`, `STICKY_SIZE_PRESETS`) для валидации

### Трансформации (`transforms.ts`)

Функции преобразования входных данных → формат API:

```typescript
// Общая для MCP и REST
export function resolveStickyNote(params) {
  let finalWidth = params.width;
  let finalShape = params.shape;
  if (params.size) {
    finalWidth = finalWidth ?? STICKY_SIZE_PRESETS[params.size];
    finalShape = 'rectangle';
  }
  return { stickyData, finalShape };
}

export function transformBulkItems(items) { /* ... */ }
export function formatSharingPolicy(sp)   { /* ... */ }
```

**Важно:** трансформации вызываются из **обоих** интерфейсов. Это гарантирует идентичное поведение.

---

## 3. Claude Desktop: удалённый MCP-сервер

### Подключение

Claude Desktop поддерживает удалённые MCP-серверы через URL:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "miro": {
      "url": "https://xxx.execute-api.eu-central-1.amazonaws.com/prod/mcp"
    }
  }
}
```

Или через UI Claude Desktop: Settings → MCP Servers → Add → вставить URL.

### Протокол

Claude Desktop общается по **MCP Protocol** (JSON-RPC 2.0 over HTTP):

```
POST /mcp
Authorization: Bearer <oauth_token>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "create_sticky_note",
    "arguments": { "boardId": "abc123", "content": "Hello" }
  },
  "id": 1
}
```

### Что нужно в Lambda

1. **OAuth-прокси** — полный набор эндпоинтов (см. [первый документ](stateless-mcp-lambda.md#5-oauth-прокси-паттерн)):
   - `GET /oauth/resource-metadata` — RFC 9728
   - `GET /.well-known/openid-configuration` — OIDC discovery
   - `POST /oauth/register` — Dynamic Client Registration
   - `GET /oauth/authorize` — redirect к провайдеру
   - `POST /oauth/token` — token exchange proxy

2. **401 с WWW-Authenticate** — триггер для OAuth flow:
   ```typescript
   {
     statusCode: 401,
     headers: {
       'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/oauth/resource-metadata"`,
     },
     body: JSON.stringify({ error: 'Unauthorized' }),
   }
   ```

3. **Stateless transport** — `sessionIdGenerator: undefined`, `enableJsonResponse: true`

4. **Per-request lifecycle** — fresh McpServer + transport per Lambda invocation

### Формат ответов MCP tools

Инструменты возвращают **text content**, не JSON-объекты:

```typescript
server.registerTool("list_boards", { /* schema */ },
  async (params) => ({
    content: [
      { type: "text", text: "Showing 5 of 42 boards (offset: 0)" },
      { type: "text", text: "Board ID: abc123, Name: Sprint Board" },
      { type: "text", text: "Board ID: def456, Name: Retro Board" },
    ],
  })
);
```

Claude Desktop читает текст, понимает структуру, и формирует ответ пользователю.

---

## 4. ChatGPT Actions: REST API + OpenAPI

### Архитектура

ChatGPT Actions работает через стандартный REST API:

```
ChatGPT → GET /boards?limit=5 → Lambda → JSON response
ChatGPT → POST /boards/{id}/sticky-notes → Lambda → JSON response
```

### Что нужно

1. **REST Lambda** с роутером и JSON-ответами
2. **OpenAPI 3.1 спецификация** (`openapi.json`) — ChatGPT парсит её для понимания API
3. **OAuth2 конфигурация** в OpenAPI spec — для автоматической авторизации
4. **Privacy Policy URL** — обязательное требование ChatGPT

### Роутер (`router.ts`)

Простой pattern-based роутер, извлекающий path-параметры:

```typescript
const routes = [
  compileRoute('GET',   '/boards',                         'listBoards'),
  compileRoute('GET',   '/boards/:boardId/frames',         'getFrames'),
  compileRoute('POST',  '/boards/:boardId/sticky-notes',   'createStickyNote'),
  compileRoute('POST',  '/boards/:boardId/items/bulk',     'bulkCreateItems'),
  compileRoute('PATCH', '/boards/:boardId/sharing',         'updateBoardSharing'),
  // ...
];

export function matchRoute(method, path): { handler, params } | null {
  // regex matching с извлечением :boardId, :frameId и т.д.
}
```

### Обработчик (`handler.ts`)

Switch по имени handler, JSON-ответы:

```typescript
export async function handleRequest(req, miroClient, boardFilter) {
  const route = matchRoute(req.method, req.path);
  if (!route) return errorResponse(404, `No route found`);

  switch (route.handler) {
    case 'listBoards': {
      const boards = await miroClient.getBoardsPage(filter, limit, offset);
      return jsonResponse(200, boards); // ← JSON, не text content
    }
    case 'createStickyNote': {
      const { stickyData } = resolveStickyNote(body); // ← та же функция
      const note = await miroClient.createStickyNote(boardId, stickyData);
      return jsonResponse(201, { id: note.id });
    }
    // ...
  }
}
```

### Обработка ошибок

REST возвращает HTTP status codes (ChatGPT их понимает):

```typescript
catch (err) {
  const message = err.message;
  const statusCode = message.includes('404') ? 404
    : message.includes('403') ? 403
    : message.includes('401') ? 401
    : 500;
  return errorResponse(statusCode, message);
}
```

MCP возвращает текстовые ошибки в content (Claude Desktop их читает как текст).

---

## 5. OAuth: одна авторизация — два клиента

### Ключевое различие

| | Claude Desktop (MCP) | ChatGPT Actions |
|---|---|---|
| **OAuth flow** | Через OAuth-прокси в Lambda | Через настройки GPT Actions |
| **Client credentials** | Lambda хранит и инжектирует | В настройках GPT Actions |
| **Token storage** | Claude Desktop хранит | ChatGPT хранит |
| **Token передача** | `Authorization: Bearer` header | `Authorization: Bearer` header |

### Claude Desktop: OAuth-прокси

Claude Desktop использует **OAuth discovery** для автоматической настройки:

1. Отправляет `POST /mcp` → получает `401` с `WWW-Authenticate` header
2. Извлекает URL `/oauth/resource-metadata` → узнаёт authorization server
3. Запрашивает `/.well-known/openid-configuration` → узнаёт эндпоинты
4. Регистрируется через `POST /oauth/register` → получает proxy `client_id`
5. Перенаправляет пользователя на `/oauth/authorize` → Lambda подменяет `client_id`
6. Обменивает код на токен через `POST /oauth/token` → Lambda инжектирует `client_secret`

**Результат:** пользователь видит только окно авторизации Miro. Secrets остаются на сервере.

### ChatGPT: OAuth через настройки GPT

В ChatGPT Actions OAuth настраивается вручную в UI:

```
Authentication: OAuth
Client ID:       <MIRO_CLIENT_ID>
Client Secret:   <MIRO_CLIENT_SECRET>
Authorization URL: https://miro.com/oauth/authorize
Token URL:         https://api.miro.com/v1/oauth/token
Scope:             boards:read boards:write
```

**Важно:** ChatGPT хранит credentials на своей стороне. Прокси не нужен — ChatGPT сам обменивает код на токен.

### Можно ли использовать один OAuth-прокси для обоих?

Да. Можно указать в ChatGPT Actions URL прокси вместо прямых Miro URL:

```
Authorization URL: https://xxx.execute-api.../prod/oauth/authorize
Token URL:         https://xxx.execute-api.../prod/oauth/token
```

Тогда `client_secret` не хранится в настройках ChatGPT — только в Lambda env vars.
Это безопаснее, но добавляет latency (дополнительный hop через Lambda).

---

## 6. Различия в форматах ответов

### Одна операция — два формата

**`list_boards` через MCP (Claude Desktop):**

```json
{
  "content": [
    { "type": "text", "text": "Showing 3 of 42 boards (offset: 0, sorted by last_modified) (my boards)" },
    { "type": "text", "text": "Board ID: abc123, Name: Sprint Board, Owner: Alice" },
    { "type": "text", "text": "Board ID: def456, Name: Retro Board, Owner: Bob" },
    { "type": "text", "text": "Board ID: ghi789, Name: Roadmap, Owner: Alice" }
  ]
}
```

**`listBoards` через REST (ChatGPT):**

```json
{
  "data": [
    { "id": "abc123", "name": "Sprint Board", "owner": { "name": "Alice" } },
    { "id": "def456", "name": "Retro Board", "owner": { "name": "Bob" } },
    { "id": "ghi789", "name": "Roadmap", "owner": { "name": "Alice" } }
  ],
  "total": 42,
  "size": 3,
  "offset": 0
}
```

### Почему разные форматы?

- **MCP** (Claude Desktop) — Claude читает текст и сам структурирует ответ. Текстовый формат проще для LLM, занимает меньше токенов, содержит уже отформатированную информацию.
- **REST** (ChatGPT) — ChatGPT парсит JSON по OpenAPI-схеме. Структурированный JSON даёт ChatGPT возможность точно извлекать поля.

### Рекомендация

Не пытайтесь унифицировать формат. Каждый клиент работает лучше со своим:

| Аспект | MCP (text content) | REST (JSON) |
|--------|-------------------|-------------|
| Формат | Человекочитаемый текст | Структурированный JSON |
| Потребление токенов | Меньше (нет ключей JSON) | Больше (полная структура) |
| Гибкость парсинга | LLM сам извлекает данные | Точное извлечение по схеме |
| Ошибки | Текст в content | HTTP status codes |

---

## 7. OpenAPI-спецификация для GPT Actions

### Структура `openapi.json`

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "My API",
    "description": "REST API for ... Used as a backend for ChatGPT GPT Actions.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://xxx.execute-api.eu-central-1.amazonaws.com/prod",
      "description": "Production"
    }
  ],
  "paths": { /* ... */ },
  "components": {
    "securitySchemes": {
      "OAuth": {
        "type": "oauth2",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": "https://xxx.../oauth/authorize",
            "tokenUrl": "https://xxx.../oauth/token",
            "scopes": {
              "boards:read": "Read data",
              "boards:write": "Create and modify"
            }
          }
        }
      }
    }
  },
  "security": [
    { "OAuth": ["boards:read", "boards:write"] }
  ]
}
```

### Рекомендации по OpenAPI для ChatGPT

1. **`operationId`** — уникальные, понятные имена. ChatGPT использует их для выбора операции:
   ```json
   "operationId": "createStickyNote"  // ← ChatGPT видит это имя
   ```

2. **`description` в paths** — подробные, на естественном языке. ChatGPT читает их для понимания, когда вызывать операцию:
   ```json
   "description": "Creates a sticky note on the specified board. Use size presets (klitzeklein, klein, medium, mittelgroß, groß, riesengroß) for consistent sizing."
   ```

3. **`enum` для параметров** — ChatGPT использует enum для генерации корректных значений:
   ```json
   "color": { "type": "string", "enum": ["yellow", "red", "blue", ...] }
   ```

4. **`default` values** — уменьшают количество параметров, которые ChatGPT должен заполнить:
   ```json
   "limit": { "type": "integer", "default": 20, "maximum": 50 }
   ```

5. **Минимум вложенности** — ChatGPT лучше работает с плоскими структурами. Если можно — выносите поля на верхний уровень:
   ```json
   // ✅ Хорошо для ChatGPT
   { "content": "text", "color": "yellow", "x": 0, "y": 0 }

   // ⚠️ Хуже — ChatGPT может ошибиться во вложенности
   { "data": { "content": "text" }, "style": { "fillColor": "yellow" }, "position": { "x": 0 } }
   ```

6. **Размер спецификации** — ChatGPT имеет лимит на размер OpenAPI spec. Не включайте все возможные эндпоинты — только те, которые нужны GPT.

### OAuth URL: прокси или напрямую?

**Вариант A — через прокси (рекомендуется):**
```json
"authorizationUrl": "https://your-api.../oauth/authorize",
"tokenUrl": "https://your-api.../oauth/token"
```
- Client secret остаётся на сервере
- Можно фиксить баги провайдера (expires_in: 0)
- В настройках GPT Actions `client_secret` можно оставить пустым или dummy

**Вариант B — напрямую к провайдеру:**
```json
"authorizationUrl": "https://miro.com/oauth/authorize",
"tokenUrl": "https://api.miro.com/v1/oauth/token"
```
- Проще, но client_secret хранится в ChatGPT
- Нет возможности фиксить ответы провайдера

---

## 8. Инфраструктура: два Lambda на одном API Gateway

### SAM Template

```yaml
Resources:
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod
      CorsConfiguration:
        AllowOrigins: ["*"]
        AllowMethods: [GET, POST, PATCH, DELETE, OPTIONS]
        AllowHeaders: [Authorization, Content-Type]

  # REST API — для ChatGPT Actions
  RestFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: lambda.handler
      CodeUri: dist/
      ReservedConcurrentExecutions: 50
      Environment:
        Variables:
          MIRO_TEAM_ID: !Ref MiroTeamId
      Events:
        ListBoards:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards
            Method: GET
        CreateStickyNote:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards/{boardId}/sticky-notes
            Method: POST
        # ... остальные REST-эндпоинты

  # MCP Protocol — для Claude Desktop
  McpFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: mcp-lambda.handler
      CodeUri: dist/
      ReservedConcurrentExecutions: 50
      Environment:
        Variables:
          MIRO_CLIENT_ID: !Ref MiroClientId
          MIRO_CLIENT_SECRET: !Ref MiroClientSecret
      Events:
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
        # ... OAuth-эндпоинты
```

### Почему два Lambda, а не один?

1. **Разные зависимости** — MCP Lambda тянет `@modelcontextprotocol/sdk` (~1.1 MB). REST Lambda — только бизнес-логика (~500 KB).
2. **Разные env vars** — MCP нужен `MIRO_CLIENT_ID`/`MIRO_CLIENT_SECRET` для OAuth-прокси. REST — только `MIRO_TEAM_ID`.
3. **Независимое масштабирование** — `ReservedConcurrentExecutions` отдельно для каждого.
4. **Изоляция ошибок** — баг в OAuth-прокси не ломает REST API.

### Один API Gateway

Оба Lambda подключаются к **одному** `HttpApi`. Один домен, один SSL-сертификат:

```
https://xxx.execute-api.eu-central-1.amazonaws.com/prod/
├── /mcp              → McpFunction
├── /oauth/*          → McpFunction
├── /.well-known/*    → McpFunction
├── /boards           → RestFunction
├── /boards/{id}/*    → RestFunction
```

---

## 9. Подводные камни и workarounds

### 9.1 ChatGPT: пользователи из внешних Miro-организаций

Если пользователь ChatGPT авторизуется через Miro, но находится в **другой организации**, чем владелец Miro App — нужно разрешить это в настройках Miro App:

> Miro App Settings → Permissions → Allow users outside your organization

Без этого OAuth будет проходить, но API-вызовы вернут 403.

### 9.2 ChatGPT: Privacy Policy

ChatGPT **требует** URL privacy policy при публикации GPT. Это может быть:
- Страница на GitHub Pages (`docs/index.html`)
- Отдельный эндпоинт API
- Любой публичный URL

### 9.3 ChatGPT: ограничение на размер OpenAPI spec

ChatGPT имеет лимит на размер спецификации. Если API большой:
- Убирайте `description` из внутренних schema-объектов (оставляйте на уровне paths)
- Используйте `$ref` для повторяющихся схем
- Не включайте ненужные эндпоинты

### 9.4 ChatGPT: `enum` с Unicode

ChatGPT корректно работает с Unicode в `enum` значениях:
```json
"size": { "enum": ["klitzeklein", "klein", "medium", "mittelgroß", "groß", "riesengroß"] }
```
Но убедитесь, что ваш API тоже корректно обрабатывает Unicode в query parameters и body.

### 9.5 Claude Desktop: `expires_in: 0`

Некоторые OAuth-провайдеры возвращают `expires_in: 0` (бессрочный токен). Claude Desktop интерпретирует это как «токен истёк» → бесконечный refresh loop. Фиксить в OAuth-прокси:

```typescript
if (tokenData.expires_in === 0 || !tokenData.expires_in) {
  tokenData.expires_in = 31536000; // 1 год
}
```

### 9.6 Claude Desktop: CORS не нужен

Claude Desktop — десктопное приложение, не браузер. CORS-заголовки ему не нужны. Но ChatGPT вызывает API из браузерного контекста — CORS обязателен. Поскольку оба клиента используют один API Gateway, CORS настраивается для всех.

### 9.7 Разные MCP-инструменты и REST-эндпоинты

Не обязательно 1:1 маппинг между MCP tools и REST endpoints. MCP-инструменты могут:
- Объединять несколько API-вызовов (например, `get_board_access` = `getBoardDetails` + `getBoardMembers`)
- Возвращать отформатированный текст вместо raw JSON
- Иметь дополнительные инструменты, не имеющие REST-аналогов (например, MCP resources)

### 9.8 Description engineering

MCP tool descriptions и OpenAPI operation descriptions служат разным целям:

**MCP (Claude Desktop)** — описание определяет, когда Claude выберет инструмент:
```typescript
description:
  "Create a sticky note on a Miro board. Available colors: gray, light_yellow, yellow... " +
  "Size presets: klitzeklein (325), klein (650), medium (1300)... " +
  "Use 'size' for presets or 'width' for custom size."
```
Включайте все enum-значения прямо в description — Claude их видит.

**REST (ChatGPT)** — описание + OpenAPI schema:
```json
{
  "description": "Creates a sticky note on the specified board.",
  "schema": { "color": { "enum": ["yellow", "red", "blue"] } }
}
```
ChatGPT читает enum из schema. Дублировать в description не нужно.

---

## 10. Чеклист для адаптации

### Общий слой

- [ ] API-клиент без зависимости от транспорта (`new ApiClient(token)`)
- [ ] Zod-схемы для валидации (shared между MCP и REST)
- [ ] Трансформации ввода в отдельном файле (`transforms.ts`)

### Claude Desktop (MCP)

- [ ] `WebStandardStreamableHTTPServerTransport` с `sessionIdGenerator: undefined`
- [ ] OAuth-прокси (resource-metadata, OIDC discovery, register, authorize, token)
- [ ] 401 с `WWW-Authenticate: Bearer resource_metadata="..."`
- [ ] Per-request McpServer lifecycle с cleanup в `finally`
- [ ] Transport-agnostic `registerTools()` для dual mode (stdio + Lambda)
- [ ] Text content в ответах инструментов (не JSON)
- [ ] Fix `expires_in: 0` в token exchange proxy

### ChatGPT Actions (REST)

- [ ] REST Lambda с роутером и JSON-ответами
- [ ] OpenAPI 3.1 спецификация (`openapi.json`)
- [ ] OAuth2 security scheme в OpenAPI
- [ ] `operationId` для каждого эндпоинта
- [ ] Подробные `description` для paths
- [ ] `enum` и `default` для всех параметров
- [ ] Privacy Policy URL
- [ ] HTTP status codes в ошибках (404, 403, 401, 500)
- [ ] CORS headers на всех ответах

### Инфраструктура

- [ ] Два Lambda на одном API Gateway
- [ ] `ReservedConcurrentExecutions` для каждого
- [ ] CORS в API Gateway config
- [ ] `NoEcho: true` для секретов в SAM parameters
- [ ] esbuild bundle per Lambda (разные entry points)
- [ ] Отдельные env vars (MCP: CLIENT_ID/SECRET, REST: TEAM_ID)

### Тестирование

- [ ] Unit-тесты shared business logic (MiroClient, transforms)
- [ ] MCP Inspector для локального тестирования MCP tools (stdio)
- [ ] curl для проверки OAuth flow
- [ ] Тестовый GPT с OpenAPI spec → проверить все операции
- [ ] Проверить OAuth для пользователей из внешних организаций
