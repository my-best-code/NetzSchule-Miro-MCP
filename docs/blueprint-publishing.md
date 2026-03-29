# Blueprint: npm Publishing для MCP-сервера

Справочник для настройки публикации MCP-сервера как npm-пакета с CI/CD через GitHub Actions.

---

## package.json

```json
{
  "name": "@my-org/my-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "bin": { "my-mcp": "./build/index.js" },
  "files": ["build", "resources"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc && node -e \"require('fs').chmodSync('build/index.js', '755')\"",
    "prepare": "npm run build",
    "test": "vitest run",
    "build:lambdas": "npm run build:lambda && npm run build:mcp-lambda",
    "build:lambda": "esbuild src/rest/lambda.ts --bundle --platform=node --target=node24 --outfile=dist/lambda.js --format=cjs",
    "build:mcp-lambda": "esbuild src/mcp/lambda.ts --bundle --platform=node --target=node24 --outfile=dist/mcp-lambda.js --format=cjs"
  }
}
```

**Ключевые поля:**
- `bin` — делает пакет запускаемым через `npx @my-org/my-mcp-server`
- `files` — только `build/` (tsc output) и `resources/`. `dist/` (Lambda bundles) не публикуется
- `prepare` — автосборка при `npm install` из git
- `chmod 755` — делает entry point исполняемым (для `#!/usr/bin/env node`)

---

## Версионирование

```bash
npm version patch     # 0.2.0 → 0.2.1  (баг-фикс)
npm version minor     # 0.2.1 → 0.3.0  (новая фича)
npm version major     # 0.3.0 → 1.0.0  (breaking change)
npm version prerelease --preid=beta  # → 1.0.1-beta.0
```

`npm version` обновляет `package.json` + создает git tag `v0.2.1`. После `git push --tags` CI публикует автоматически.

---

## GitHub Actions: Publish on Tag

```yaml
# .github/workflows/publish.yml
name: Publish to npm & GitHub Packages

on:
  push:
    tags: ['v*']

jobs:
  publish-npm:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  publish-gpr:
    needs: publish-npm
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          registry-url: 'https://npm.pkg.github.com'
      - run: npm ci
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Двойная публикация:** npmjs.org (основной) + GitHub Packages (бэкап). `publish-gpr` запускается только после успеха `publish-npm`.

---

## Prerequisites (one-time setup)

1. npm account + организация на npmjs.com
2. Granular Access Token (Automation type, write access) → GitHub secret `NPM_TOKEN`
3. GitHub repo в той же org

---

## Workflow: как публиковать

```bash
# 1. Убедись что тесты проходят
npm test

# 2. Обнови версию
npm version patch   # или minor/major

# 3. Push код и тег — CI опубликует
git push && git push --tags

# 4. Проверь статус
# GitHub Actions → publish workflow
```

---

## Полезные команды

```bash
npm pkg get version                          # текущая версия
npm pack --dry-run                           # что будет в пакете
npm view @my-org/my-mcp-server               # проверить на npm
npm unpublish @my-org/my-mcp-server@0.2.1    # откат (72 часа)
```

---

## Troubleshooting

| Проблема | Решение |
|----------|---------|
| 403 Forbidden | npm token истёк или нет write-доступа |
| Tag already exists | `git tag -d v0.2.1 && git push origin :refs/tags/v0.2.1`, затем `npm version` заново |
| Package name taken | Используй scope `@my-org/` — конфликтов не будет |
| `prepare` fails в CI | `npm ci` не запускает `prepare`, это нормально; `npm publish` запускает `prepublishOnly` |
