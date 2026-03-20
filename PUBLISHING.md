# Publishing Cheat Sheet

## Prerequisites (one-time setup)

1. npm account + организация `my-best-code` на [npmjs.com](https://www.npmjs.com)
2. Granular Access Token → сохранён в GitHub repo secrets как `NPM_TOKEN`
3. GitHub repo: `my-best-code/NetzSchule-Miro-MCP`

## Publishing via CI (recommended)

```bash
# 1. Убедись что все изменения закоммичены и тесты проходят
npm test

# 2. Обнови версию (обновит package.json + создаст git tag)
npm version patch     # 0.2.0 → 0.2.1  (баг-фикс)
npm version minor     # 0.2.1 → 0.3.0  (новая фича)
npm version major     # 0.3.0 → 1.0.0  (breaking change)

# 3. Пушни код и тег — CI опубликует автоматически
git push && git push --tags

# 4. Проверь статус в GitHub Actions
#    https://github.com/my-best-code/NetzSchule-Miro-MCP/actions
```

## Publishing manually (fallback)

```bash
npm login
npm publish --access public
```

## Useful commands

```bash
# Посмотреть текущую версию
npm pkg get version

# Посмотреть что будет опубликовано
npm pack --dry-run

# Проверить пакет на npm после публикации
npm view @my-best-code/netzschule-miro-mcp

# Откатить публикацию (в течение 72 часов)
npm unpublish @my-best-code/netzschule-miro-mcp@0.2.1
```

## Version numbering

| Тип изменения | Команда | Пример |
|---------------|---------|--------|
| Баг-фикс, мелкие правки | `npm version patch` | 0.2.0 → 0.2.1 |
| Новая фича (обратно совместимая) | `npm version minor` | 0.2.1 → 0.3.0 |
| Breaking change | `npm version major` | 0.3.0 → 1.0.0 |
| Pre-release | `npm version prerelease --preid=beta` | 1.0.0 → 1.0.1-beta.0 |

## Troubleshooting

**403 Forbidden** — проверь что npm-токен не истёк и имеет write-доступ к пакету.

**Package name taken** — scope `@my-best-code` принадлежит твоей org, конфликтов быть не должно.

**Tag already exists** — `git tag -d v0.2.1 && git push origin :refs/tags/v0.2.1`, затем заново `npm version`.
