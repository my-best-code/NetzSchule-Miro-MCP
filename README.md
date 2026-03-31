# NetzSchule Miro MCP Server

A Model Context Protocol server to connect to the MIRO Whiteboard Application — with a REST API adapter for ChatGPT and other LLMs.

Based on [@llmindset/mcp-miro](https://github.com/evalstate/mcp-miro), with added board filtering, element sizing, and migration to the current MCP SDK (`McpServer` API with Zod schemas).

- Allows Board manipulation, sticky creation, bulk operations and more.
- Pass your OAuth key as an Environment Variable, or using the "--token" argument.
- By default, only shows boards owned by the authenticated user. Can be configured to filter by team or show all boards.
- Input validation via Zod schemas.
- Taking a photo of stickies and asking Claude to create MIRO equivalent works _really_ well.
- **Remote MCP server** — deploy as AWS Lambda with Streamable HTTP transport and built-in OAuth proxy. Connect Claude Desktop with just a URL — no Node.js, npm, git, or Miro credentials required on the client side.
- **REST API adapter** — deploy as AWS Lambda to use with ChatGPT (GPT Actions), Gemini, or any LLM with function calling.

## Architecture

```
Claude Desktop  →  MCP (stdio)              →  MiroClient  →  Miro API   (local)
Claude Desktop  →  MCP (Streamable HTTP)    →  MiroClient  →  Miro API   (remote, serverless)
ChatGPT / GPT   →  REST API                 →  MiroClient  →  Miro API   (remote, serverless)
```

All three paths share the same `MiroClient` business logic — no duplication.

### Project Structure

```
src/
├── MiroClient.ts              # Miro API client (fetch-based, Bearer token auth)
├── MiroClient.test.ts         # Tests (Vitest)
├── schemas.ts                 # Shared Zod validation schemas
├── transforms.ts              # Data transformations (sticky notes, bulk items, policies)
├── index.ts                   # Stdio entry point (CLI)
├── mcp/
│   ├── registerTools.ts       # MCP tool/resource/prompt registration orchestrator
│   ├── lambda.ts              # AWS Lambda: Streamable HTTP + OAuth proxy
│   ├── md.d.ts                # TypeScript declaration for .md imports
│   └── tools/                 # One file per MCP tool
│       ├── types.ts           # ToolContext, RegisterTool type
│       ├── listBoards.ts
│       ├── createStickyNote.ts
│       ├── bulkCreateItems.ts
│       ├── getFrames.ts
│       ├── getItemsInFrame.ts
│       ├── createShape.ts
│       ├── getBoardAccess.ts
│       ├── updateBoardSharing.ts
│       └── getBoardShareLink.ts
└── rest/
    ├── lambda.ts              # AWS Lambda: REST API entry point
    ├── handler.ts             # Request dispatch & JSON responses
    └── router.ts              # HTTP pattern matching
```

Each MCP tool lives in its own file under `src/mcp/tools/`, making the codebase easy to navigate and extend.

The remote MCP server includes a full **OAuth proxy**: Miro Client ID and Secret are stored server-side in AWS, so end users only need the MCP URL to connect. The OAuth flow (authorization, token exchange) is handled transparently between Claude Desktop, the Lambda, and Miro.

## Features

### Resources
- **Board Contents** — dynamic resource template `miro://board/{boardId}`, with automatic board listing filtered by owner/team

### Tools
- **list_boards** — list available boards with pagination (`limit`/`offset`). Returns total board count so the LLM can paginate through large collections
- **create_sticky_note** — with customizable color, position, shape (`square`/`rectangle`), and 6 named size presets (see below)
- **create_shape** — with full control over style (`fillColor`, `borderColor`, etc.), position, and geometry (`width`, `height`, `rotation`)
- **bulk_create_items** — up to 20 items in a single transaction
- **get_frames** — get all frames from a board
- **get_items_in_frame** — get items within a specific frame
- **get_board_access** — view sharing policy (API-level settings), permissions policy, and list of board members with roles
- **update_board_sharing** — configure board access: access, team access, organization access levels. Verifies changes with a follow-up GET and warns if the update was not applied
- **get_board_share_link** — get the board's direct view link (URL). See [Miro API Sharing Limitations](#miro-api-sharing-limitations) for details

### Sticky Note Size Presets

Sticky notes support named size presets (rectangular shape, each ~2x the previous):

| Preset | Width (px) | Description |
|--------|-----------|-------------|
| `klitzeklein` | 325 | Tiny |
| `klein` | 650 | Small |
| `medium` | 1300 | Medium |
| `mittelgroß` | 2600 | Medium-large |
| `groß` | 5600 | Large |
| `riesengroß` | 11200 | Extra-large |

Using a size preset automatically sets the shape to `rectangle`. Height is auto-calculated by the Miro API (fixed W:H ratio of ~1.535:1 for rectangular stickies). You can also pass a custom `width` for arbitrary sizes.

### Prompts
- **Working with MIRO** — board coordinate system and best practices

## Board Listing

By default, `list_boards` returns **20 most recently modified boards owned by the current user**, sorted by `last_modified`. Set `scope` to `all` to see all accessible boards (including other team members' boards). This applies to all interfaces (MCP, REST API).

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | 20 | Number of boards to return (1-50) |
| `offset` | 0 | Pagination offset |
| `sort` | `last_modified` | Sort order: `last_modified`, `last_opened`, `last_created`, `alphabetically`, `default` |
| `query` | — | Search boards by name (max 500 chars) |
| `scope` | `mine` | `mine` = only my boards, `all` = all accessible boards |

### Board Filtering (local MCP only)

The local MCP server (stdio) supports additional filtering via CLI flags:

| Option | Environment Variable | Description |
|--------|---------------------|-------------|
| _(default)_ | — | Auto-detect user, show only owned boards |
| `--team-id <id>` | `MIRO_TEAM_ID` | Filter boards by team ID |
| `--no-filter` | `MIRO_NO_FILTER=true` | Disable filtering, show all accessible boards |

The remote MCP server and REST API show all boards accessible to the authenticated user by default (no owner/team filter). If `MIRO_TEAM_ID` is set as an environment variable on the Lambda, boards are filtered by that team.

**Examples (local):**

```bash
# Only my boards (default, no extra flags needed)
node build/index.js --token YOUR_TOKEN

# Filter by team
node build/index.js --token YOUR_TOKEN --team-id 1234567890

# Show all boards (legacy behavior)
node build/index.js --token YOUR_TOKEN --no-filter
```

## Remote MCP Server (Claude Desktop — no installation required)

The MCP server can be deployed to AWS Lambda with Streamable HTTP transport and a built-in OAuth proxy. End users connect from Claude Desktop with just a URL — no Node.js, npm, git, or Miro credentials needed on the client side.

### How it works

```
Claude Desktop                     AWS Lambda                    Miro
      |                               |                           |
      |--- POST /mcp ---------------->|                           |
      |<-- 401 + WWW-Authenticate     |                           |
      |                               |                           |
      |--- discover OAuth metadata -->|                           |
      |<-- { authorization_endpoint,  |                           |
      |      token_endpoint, ... }    |                           |
      |                               |                           |
      |--- open browser --------------|-------------------------->|
      |                               |    Miro login + authorize |
      |<-- redirect with auth code ---|<--------------------------|
      |                               |                           |
      |--- POST /oauth/token -------->|--- proxy to Miro -------->|
      |    (code)                     |   (+ inject client_id     |
      |<-- { access_token } ----------|<-- + client_secret) ------|
      |                               |                           |
      |--- POST /mcp (Bearer) ------->|--- Miro API calls ------->|
      |<-- MCP response               |<-- board data ------------|
```

Key points:
- **OAuth proxy** — Miro Client ID and Secret are stored server-side in AWS. The Lambda injects them during token exchange, so users never see or handle these credentials.
- **Dynamic Client Registration (RFC 7591)** — Claude Desktop automatically registers as an OAuth client.
- **Stateless** — each Lambda invocation creates a fresh MCP server. No session state, no DynamoDB, no ElastiCache.
- **Auto-detection** — boards are automatically filtered to those owned by the authenticated user.

### Connecting from Claude Desktop

1. Open Claude Desktop → **Settings** → **Integrations** → **Add custom connector** (or **Add More**)
2. Enter the MCP server URL: `https://YOUR_API_GATEWAY_URL/prod/mcp`
3. Click **Connect** — a browser window opens for Miro authorization
4. Authorize the Miro App — Claude Desktop receives a token automatically
5. Done — Miro tools appear in your chat

> No API keys, tokens, or credentials needed on the client side. The OAuth flow handles everything.

### Connecting via config file (alternative)

If you already have a Miro OAuth token, you can configure Claude Desktop directly:

```json
{
  "mcpServers": {
    "mcp-miro": {
      "url": "https://YOUR_API_GATEWAY_URL/prod/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MIRO_OAUTH_TOKEN"
      }
    }
  }
}
```

Config file location:
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

### Deploying the Remote MCP Server

To deploy to your own AWS account:

#### Prerequisites

1. **AWS CLI** and **AWS SAM CLI** installed and configured
2. **Miro App** — create one at [Miro App Management](https://miro.com/app/settings/user-profile/apps):
   - Set permissions: `boards:read`, `boards:write`
   - Add the Claude Desktop redirect URI to your Miro App's **Redirect URIs**
   - Note the **Client ID** and **Client Secret**
3. **S3 bucket** for SAM deployment artifacts

#### Deploy

1. Build the Lambda bundles:
```bash
npm ci
npm run build:lambdas
```

2. Deploy with AWS SAM:
```bash
sam build --no-use-container
sam deploy \
  --stack-name miro-mcp-rest-api \
  --s3-bucket YOUR_SAM_BUCKET \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    MiroTeamId=YOUR_TEAM_ID \
    MiroClientId=YOUR_MIRO_CLIENT_ID \
    MiroClientSecret=YOUR_MIRO_CLIENT_SECRET
```

- `MiroTeamId` — optional, filters boards for the REST API Lambda
- `MiroClientId` / `MiroClientSecret` — required for the OAuth proxy (MCP Lambda only)

The stack outputs:
- `McpUrl` — MCP Streamable HTTP endpoint (share with Claude Desktop users)
- `ApiUrl` — REST API endpoint (for ChatGPT GPT Actions)

#### CI/CD Deployment

The project includes a GitHub Actions workflow (`deploy-lambda.yml`) for automated deployment. Configure these GitHub Secrets:

| Secret | Description |
|--------|-------------|
| `AWS_ROLE_ARN` | IAM role ARN for OIDC-based AWS authentication |
| `SAM_BUCKET` | S3 bucket for SAM deployment artifacts |
| `MIRO_TEAM_ID` | Miro team ID (for REST API board filtering) |
| `MCP_MIRO_CLIENT_ID` | Miro App Client ID (for OAuth proxy) |
| `MCP_MIRO_CLIENT_SECRET` | Miro App Client Secret (for OAuth proxy) |

Trigger the workflow manually via GitHub Actions → "Deploy REST API" → Run workflow.

---

## Local Installation (Claude Desktop)

### Prerequisites

1. **Node.js** (v18 or later) — [download here](https://nodejs.org/)
   - To check if already installed: open Terminal (Mac) or Command Prompt (Windows) and run `node --version`
2. **Miro OAuth Token** — from your Miro App (see [Miro App Management](https://miro.com/app/settings/user-profile/apps)). If your organization already has a Miro App, ask the admin for the Installation URL to authorize it and obtain your token.
3. **Claude Desktop** — with Developer Tools enabled (Settings → Developer)

### Step 1: Install the MCP server

Open Terminal (Mac) or Command Prompt (Windows) and run:

```bash
git clone https://github.com/my-best-code/NetzSchule-Miro-MCP.git
cd NetzSchule-Miro-MCP
npm install
npm run build
```

Note the full path to the `build/index.js` file — you'll need it in the next step. For example:
- Mac: `/Users/yourname/NetzSchule-Miro-MCP/build/index.js`
- Windows: `C:\Users\yourname\NetzSchule-Miro-MCP\build\index.js`

### Step 2: Configure Claude Desktop

Open the config file:
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

Add the following (replace the paths and token with your own):

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "node",
      "arguments": [
        "/full/path/to/NetzSchule-Miro-MCP/build/index.js",
        "--token", "YOUR_MIRO_OAUTH_TOKEN"
      ]
    }
  }
}
```

### Step 3: Restart Claude Desktop

Close and reopen Claude Desktop. You should see the Miro tools available in the chat.

### Additional options

To filter boards by team, add the `--team-id` argument:

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "node",
      "arguments": [
        "/full/path/to/NetzSchule-Miro-MCP/build/index.js",
        "--token", "YOUR_MIRO_OAUTH_TOKEN",
        "--team-id", "1234567890"
      ]
    }
  }
}
```

Or use environment variables instead of arguments:

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "node",
      "arguments": [
        "/full/path/to/NetzSchule-Miro-MCP/build/index.js"
      ],
      "env": {
        "MIRO_OAUTH_TOKEN": "YOUR_MIRO_OAUTH_TOKEN",
        "MIRO_TEAM_ID": "1234567890"
      }
    }
  }
}
```

## REST API for ChatGPT (GPT Actions)

In addition to MCP (for Claude), this project includes a REST API adapter that can be deployed as an AWS Lambda. This makes the same Miro tools available to ChatGPT users via GPT Actions, or any LLM that supports OpenAPI / function calling.

### Authentication

The REST API uses **Miro OAuth per user**. Each request must include a valid Miro OAuth token in the `Authorization: Bearer <token>` header. There is no shared API key — every user authenticates with their own Miro account.

When used with ChatGPT GPT Actions, the OAuth flow is handled automatically: users authorize the Miro App once, and ChatGPT sends their token with every request.

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards` | List available boards (max 50 per page) |
| `GET` | `/boards/:boardId/frames` | Get all frames |
| `GET` | `/boards/:boardId/frames/:frameId/items` | Get items in frame |
| `GET` | `/boards/:boardId/access` | Get board access info |
| `GET` | `/boards/:boardId/share-link` | Get board view link |
| `POST` | `/boards/:boardId/sticky-notes` | Create sticky note |
| `POST` | `/boards/:boardId/items/bulk` | Bulk create items (max 20) |
| `POST` | `/boards/:boardId/shapes` | Create shape |
| `PATCH` | `/boards/:boardId/sharing` | Update sharing policy |

### Setting up GPT Actions (ChatGPT)

#### Prerequisites

You need a **Miro App** for OAuth. If you're in the same Miro organization as the app creator, use the shared Installation URL. Otherwise, create your own:

1. Go to [Miro App Management](https://miro.com/app/settings/user-profile/apps) → **Create new app**
2. Set permissions: `boards:read`, `boards:write`
3. Note the **Client ID** and **Client Secret**

#### Creating the Custom GPT

> Requires ChatGPT Plus. Once created, the GPT can be shared with anyone (including free users).

1. Go to [ChatGPT](https://chat.openai.com) → **Create a GPT**
2. In the **Actions** section, import the OpenAPI schema from `openapi.json`
3. Update `servers.url` to your API Gateway URL
4. Configure **Authentication**:
   - Type: **OAuth**
   - Authorization URL: `https://miro.com/oauth/authorize`
   - Token URL: `https://api.miro.com/v1/oauth/token`
   - Client ID / Client Secret: from your Miro App
   - Scope: `boards:read boards:write`
5. Copy the **Callback URL** provided by ChatGPT
6. In your Miro App settings, add this Callback URL as a **Redirect URI**
7. Publish the GPT (e.g., "Anyone with the link")

#### For users outside your Miro organization

Users from other Miro organizations cannot authorize a Draft Miro App. They have two options:

1. **Create their own Miro App** (recommended) — takes 5 minutes, gives them their own Client ID / Secret, then they create their own GPT Action following the steps above
2. **Publish the Miro App** to the Miro Marketplace — makes it available to all Miro users, but requires Miro review and approval

The OpenAPI schema (`openapi.json`) is also compatible with other LLM frameworks that support function calling (LangChain, Google ADK, etc.).

## Miro API Sharing Limitations

The Miro REST API v2 has important limitations regarding board sharing that differ from the Miro UI:

### Two different sharing mechanisms

| Mechanism | API Support | Description |
|-----------|-------------|-------------|
| **`inviteToAccountAndBoardLinkAccess`** | ✅ Read/Write | API-level setting that controls global link access. May be restricted by organization settings (often locked to `no_access`). |
| **UI share links** (`?share_link_id=...`) | ❌ Not supported | Share links generated in Miro UI (Share > Copy board link) with specific permissions. These are a UI-only feature — the Miro API cannot create, read, update, or delete them. |
| **Board members** | ✅ Read/Write | Invite specific users by email via `POST /v2/boards/{board_id}/members`. |
| **`viewLink`** | ✅ Read-only | Direct URL to the board (no embedded permissions). |

### What this means in practice

- **`get_board_share_link`** returns the board's `viewLink` (direct URL), **not** a UI-generated share link with `share_link_id`.
- **`get_board_access`** shows `inviteToAccountAndBoardLinkAccess` which may show `no_access` even if the board has an active UI share link with Editor access. These are independent settings.
- **`update_board_sharing`** can change `inviteToAccountAndBoardLinkAccess`, but this may be overridden or restricted by organization-level policies.
- To create a share link with specific permissions, use the **Miro UI**: Share > "Anyone with the link" > select access level > Copy board link.

> **Source**: [Miro Community — confirmed by Miro staff](https://community.miro.com/developer-platform-and-apis-57/how-to-get-the-share-board-link-of-a-web-whiteboard-programmatically-6031) that share link URLs with `share_link_id` are only supported by the Miro UI.

## CI/CD

The project uses GitHub Actions for continuous integration, publishing, and deployment:

- **CI** (`ci.yml`) — runs on every push to `main` and on pull requests: installs dependencies, builds, runs tests.
- **Security** (`security.yml`) — runs on every push to `main`, on pull requests, and weekly: `npm audit` and CodeQL analysis.
- **Publish** (`publish.yml`) — triggers on git tags matching `v*`: runs tests and publishes to npm.
- **Deploy** (`deploy-lambda.yml`) — manual trigger (`workflow_dispatch`): builds Lambda bundles, runs tests, deploys to AWS via SAM.

### Publishing a new version

```bash
npm version patch   # 0.9.7 → 0.9.8 (or: minor, major)
git push && git push --tags
```

GitHub Actions will automatically run tests and publish the package to npm.

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

Run tests:
```bash
npm test
```

Build Lambda bundles:
```bash
npm run build:lambda       # REST API only
npm run build:mcp-lambda   # MCP Streamable HTTP only
npm run build:lambdas      # both
```

For development with auto-rebuild:
```bash
npm run watch
```

### Adding a New MCP Tool

Each tool is a self-contained file in `src/mcp/tools/`. To add a new one:

**1. Create the tool file** — e.g. `src/mcp/tools/deleteBoard.ts`:

```typescript
import { z } from 'zod';
import type { RegisterTool } from './types.js';

export const registerDeleteBoard: RegisterTool = (server, ctx) => {
  server.registerTool(
    'delete_board',
    {
      description: 'Delete a Miro board',
      inputSchema: {
        boardId: z.string().describe('ID of the board to delete'),
      },
    },
    async ({ boardId }) => {
      // call ctx.miroClient methods here
      return {
        content: [{ type: 'text', text: `Deleted board ${boardId}` }],
      };
    },
  );
};
```

The `ctx` object provides `miroClient` (Miro API client) and `boardFilter` (current board filtering config).

**2. Register it** — add two lines to `src/mcp/registerTools.ts`:

```typescript
import { registerDeleteBoard } from './tools/deleteBoard.js';

const tools: RegisterTool[] = [
  // ...existing tools
  registerDeleteBoard,  // ← add here
];
```

That's it. The tool is now available via MCP stdio and the remote Lambda.

If the tool needs a new API method, add it to `MiroClient.ts`. If it needs shared validation, add the schema to `schemas.ts`.

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

Original work by [evalstate](https://github.com/evalstate/mcp-miro).
