# NetzSchule Miro MCP Server

A Model Context Protocol server to connect to the MIRO Whiteboard Application.

Based on [@llmindset/mcp-miro](https://github.com/evalstate/mcp-miro), with added board filtering, element sizing, and migration to the current MCP SDK (`McpServer` API with Zod schemas).

- Allows Board manipulation, sticky creation, bulk operations and more.
- Pass your OAuth key as an Environment Variable, or using the "--token" argument.
- By default, only shows boards owned by the authenticated user. Can be configured to filter by team or show all boards.
- Input validation via Zod schemas.
- Taking a photo of stickies and asking Claude to create MIRO equivalent works _really_ well.

## Features

### Resources
- **Board Contents** — dynamic resource template `miro://board/{boardId}`, with automatic board listing filtered by owner/team

### Tools
- **list_boards** — list available boards (with owner/team info)
- **create_sticky_note** — with customizable color, position, and size (`width`, `height`)
- **create_shape** — with full control over style (`fillColor`, `borderColor`, etc.), position, and geometry (`width`, `height`, `rotation`)
- **bulk_create_items** — up to 20 items in a single transaction
- **get_frames** — get all frames from a board
- **get_items_in_frame** — get items within a specific frame

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
