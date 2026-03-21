# NetzSchule Miro MCP Server

A Model Context Protocol server to connect to the MIRO Whiteboard Application — with a REST API adapter for ChatGPT and other LLMs.

Based on [@llmindset/mcp-miro](https://github.com/evalstate/mcp-miro), with added board filtering, element sizing, and migration to the current MCP SDK (`McpServer` API with Zod schemas).

- Allows Board manipulation, sticky creation, bulk operations and more.
- Pass your OAuth key as an Environment Variable, or using the "--token" argument.
- By default, only shows boards owned by the authenticated user. Can be configured to filter by team or show all boards.
- Input validation via Zod schemas.
- Taking a photo of stickies and asking Claude to create MIRO equivalent works _really_ well.
- **REST API adapter** — deploy as AWS Lambda to use with ChatGPT (GPT Actions), Gemini, or any LLM with function calling.

## Features

### Resources
- **Board Contents** — dynamic resource template `miro://board/{boardId}`, with automatic board listing filtered by owner/team

### Tools
- **list_boards** — list available boards (with owner/team info)
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

## Board Filtering

By default, the server automatically detects the current user via the Miro API and only returns boards owned by that user. This behavior can be configured:

| Option | Environment Variable | Description |
|--------|---------------------|-------------|
| _(default)_ | — | Auto-detect user, show only owned boards |
| `--team-id <id>` | `MIRO_TEAM_ID` | Filter boards by team ID |
| `--no-filter` | `MIRO_NO_FILTER=true` | Disable filtering, show all accessible boards |

**Examples:**

```bash
# Only my boards (default, no extra flags needed)
node build/index.js --token YOUR_TOKEN

# Filter by team
node build/index.js --token YOUR_TOKEN --team-id 1234567890

# Show all boards (legacy behavior)
node build/index.js --token YOUR_TOKEN --no-filter
```

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "/path/to/node-or-npx",
      "arguments": [
        "/path/to/mcp-miro/build/index.js",
        "--token", "MIRO-OAUTH-KEY"
      ]
    }
  }
}
```

To filter by team or show all boards, add the corresponding arguments:

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "/path/to/node-or-npx",
      "arguments": [
        "/path/to/mcp-miro/build/index.js",
        "--token", "MIRO-OAUTH-KEY",
        "--team-id", "1234567890"
      ]
    }
  }
}
```

Or use environment variables:

```json
{
  "mcpServers": {
    "mcp-miro": {
      "command": "/path/to/node-or-npx",
      "arguments": [
        "/path/to/mcp-miro/build/index.js"
      ],
      "env": {
        "MIRO_OAUTH_TOKEN": "MIRO-OAUTH-KEY",
        "MIRO_TEAM_ID": "1234567890"
      }
    }
  }
}
```

## REST API for ChatGPT (GPT Actions)

In addition to MCP (for Claude), this project includes a REST API adapter that can be deployed as an AWS Lambda. This makes the same Miro tools available to ChatGPT users via GPT Actions, Gemini, or any LLM that supports function calling.

### Architecture

```
Claude Desktop  →  MCP (stdio)  →  MiroClient  →  Miro API
ChatGPT / GPT   →  REST API     →  MiroClient  →  Miro API
```

Both paths share the same `MiroClient` business logic — no duplication.

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards` | List available boards |
| `GET` | `/boards/:boardId/frames` | Get all frames |
| `GET` | `/boards/:boardId/frames/:frameId/items` | Get items in frame |
| `GET` | `/boards/:boardId/access` | Get board access info |
| `GET` | `/boards/:boardId/share-link` | Get board view link |
| `POST` | `/boards/:boardId/sticky-notes` | Create sticky note |
| `POST` | `/boards/:boardId/items/bulk` | Bulk create items (max 20) |
| `POST` | `/boards/:boardId/shapes` | Create shape |
| `PATCH` | `/boards/:boardId/sharing` | Update sharing policy |

### Deployment (AWS)

1. Build the Lambda bundle:
```bash
npm run build:lambda
```

2. Deploy with AWS SAM:
```bash
sam deploy --guided
```

Required environment variables:
- `MIRO_OAUTH_TOKEN` — Miro OAuth token
- `REST_API_KEY` — API key for authenticating requests
- `MIRO_TEAM_ID` — (optional) filter boards by team

3. Configure GPT Actions in ChatGPT:
   - Create a Custom GPT
   - Add an Action, paste the OpenAPI schema from `src/rest/openapi.yaml`
   - Update the `servers.url` to your API Gateway URL
   - Set authentication: API Key, Bearer scheme

The OpenAPI schema is also compatible with Gemini (Vertex AI tools), LangChain, and other LLM frameworks.

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

The project uses GitHub Actions for continuous integration and publishing:

- **CI** (`ci.yml`) — runs on every push to `main` and on pull requests: installs dependencies, builds, runs tests.
- **Publish** (`publish.yml`) — triggers on git tags matching `v*`: runs tests and publishes to npm.

### Publishing a new version

```bash
npm version patch   # 0.2.0 → 0.2.1 (or: minor, major)
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

Build Lambda bundle (for REST API deployment):
```bash
npm run build:lambda
```

For development with auto-rebuild:
```bash
npm run watch
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

Original work by [evalstate](https://github.com/evalstate/mcp-miro).
