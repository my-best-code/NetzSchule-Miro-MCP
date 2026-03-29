# Blueprint: DevOps для MCP-сервера на AWS Lambda

CI/CD pipeline: GitHub Actions + AWS SAM + Lambda versioning/rollback.

---

## Архитектура pipeline

```
git push (main)  ──→  CI (test, lint, build)
git push --tags  ──→  Publish npm + GitHub Packages
workflow_dispatch ──→  Deploy Lambda (SAM)
workflow_dispatch ──→  Mark Stable / Rollback
schedule (weekly) ──→  Security (npm audit + CodeQL)
dependabot        ──→  Dependency updates (auto-PR)
```

---

## 1. CI: тесты на каждый push/PR

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run lint
      - run: npx tsc --noEmit
      - run: npm test
      - run: npm run build:lambdas
```

**4 шага проверки:** lint → typecheck → unit tests → Lambda bundle build.

---

## 2. Deploy Lambda: SAM + smoke test

```yaml
# .github/workflows/deploy-lambda.yml
name: Deploy

on:
  workflow_dispatch:    # ручной запуск из GitHub UI

permissions:
  id-token: write      # OIDC для AWS
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - run: npm ci
      - run: npm test
      - run: npm run build:lambdas

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: eu-central-1

      - uses: aws-actions/setup-sam@v2

      - run: sam build --no-use-container

      # Автоочистка ROLLBACK_COMPLETE стека
      - name: Clean up failed stack
        run: |
          STATUS=$(aws cloudformation describe-stacks \
            --stack-name my-mcp-stack \
            --query "Stacks[0].StackStatus" \
            --output text 2>/dev/null || echo "NOT_FOUND")
          if [ "$STATUS" = "ROLLBACK_COMPLETE" ]; then
            aws cloudformation delete-stack --stack-name my-mcp-stack
            aws cloudformation wait stack-delete-complete --stack-name my-mcp-stack
          fi

      - run: |
          sam deploy \
            --stack-name my-mcp-stack \
            --s3-bucket ${{ secrets.SAM_BUCKET }} \
            --capabilities CAPABILITY_IAM \
            --no-confirm-changeset \
            --no-fail-on-empty-changeset \
            --parameter-overrides \
              MiroTeamId=${{ secrets.MIRO_TEAM_ID }} \
              MiroClientId=${{ secrets.MCP_MIRO_CLIENT_ID }} \
              MiroClientSecret=${{ secrets.MCP_MIRO_CLIENT_SECRET }}

      # Smoke test после деплоя
      - name: Smoke test
        run: |
          API_URL=$(aws cloudformation describe-stacks \
            --stack-name my-mcp-stack \
            --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
            --output text)
          STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health")
          if [ "$STATUS" != "200" ]; then
            echo "Smoke test FAILED: $STATUS"
            exit 1
          fi
```

### Secrets для Deploy

| Secret | Описание |
|--------|----------|
| `AWS_ROLE_ARN` | IAM Role для OIDC (GitHub → AWS) |
| `SAM_BUCKET` | S3 bucket для SAM артефактов |
| `MIRO_TEAM_ID` | Optional: фильтрация досок |
| `MCP_MIRO_CLIENT_ID` | OAuth App Client ID |
| `MCP_MIRO_CLIENT_SECRET` | OAuth App Client Secret |

### AWS OIDC (вместо access keys)

```bash
# Одноразовая настройка — Identity Provider в AWS IAM
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

# IAM Role с trust policy для конкретного repo
```

---

## 3. Lambda Versioning: live → stable → prev-stable

```
deploy → создает новую версию → alias "live" указывает на неё
         ↓ (после проверки)
mark-stable → "stable" = текущий "live", "prev-stable" = предыдущий "stable"
         ↓ (если проблемы)
rollback → "live" переключается на "stable" или "prev-stable"
```

### Mark Stable (workflow_dispatch)

```yaml
# .github/workflows/mark-stable.yml
name: Mark Stable

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  mark-stable:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Promote live → stable
        run: |
          # Получить physical resource IDs из CloudFormation
          REST_FN=$(aws cloudformation describe-stack-resource \
            --stack-name my-mcp-stack \
            --logical-resource-id RestFunction \
            --query "StackResourceDetail.PhysicalResourceId" --output text)
          MCP_FN=$(aws cloudformation describe-stack-resource \
            --stack-name my-mcp-stack \
            --logical-resource-id McpFunction \
            --query "StackResourceDetail.PhysicalResourceId" --output text)

          for FN in "$REST_FN" "$MCP_FN"; do
            LIVE_VER=$(aws lambda get-alias --function-name "$FN" --name live \
              --query "FunctionVersion" --output text)

            # stable → prev-stable
            if STABLE_VER=$(aws lambda get-alias --function-name "$FN" --name stable \
                --query "FunctionVersion" --output text 2>/dev/null); then
              if aws lambda get-alias --function-name "$FN" --name prev-stable &>/dev/null; then
                aws lambda update-alias --function-name "$FN" --name prev-stable \
                  --function-version "$STABLE_VER" --output none
              else
                aws lambda create-alias --function-name "$FN" --name prev-stable \
                  --function-version "$STABLE_VER" --output none
              fi
            fi

            # live → stable
            if aws lambda get-alias --function-name "$FN" --name stable &>/dev/null; then
              aws lambda update-alias --function-name "$FN" --name stable \
                --function-version "$LIVE_VER" --output none
            else
              aws lambda create-alias --function-name "$FN" --name stable \
                --function-version "$LIVE_VER" --output none
            fi
          done
```

### Rollback (workflow_dispatch с input)

```yaml
# .github/workflows/rollback.yml
name: Rollback

on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Rollback target'
        required: true
        type: choice
        options:
          - stable
          - prev-stable
          - specific-version
      version:
        description: 'Version number (only for specific-version)'
        required: false
        type: string

permissions:
  id-token: write
  contents: read

jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Rollback live alias
        run: |
          REST_FN=$(aws cloudformation describe-stack-resource \
            --stack-name my-mcp-stack \
            --logical-resource-id RestFunction \
            --query "StackResourceDetail.PhysicalResourceId" --output text)
          MCP_FN=$(aws cloudformation describe-stack-resource \
            --stack-name my-mcp-stack \
            --logical-resource-id McpFunction \
            --query "StackResourceDetail.PhysicalResourceId" --output text)

          for FN in "$REST_FN" "$MCP_FN"; do
            if [ "${{ inputs.target }}" = "specific-version" ]; then
              TARGET_VER="${{ inputs.version }}"
            else
              TARGET_VER=$(aws lambda get-alias --function-name "$FN" \
                --name "${{ inputs.target }}" \
                --query "FunctionVersion" --output text)
            fi

            aws lambda update-alias --function-name "$FN" \
              --name live --function-version "$TARGET_VER" --output none
            echo "$FN: live → version $TARGET_VER"
          done
```

**Rollback — мгновенный:** переключение alias, без re-deploy. Версии Lambda иммутабельны.

---

## 4. Security: npm audit + CodeQL

```yaml
# .github/workflows/security.yml
name: Security

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'   # weekly Monday 06:00 UTC

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - run: npm ci
      - run: npm audit --audit-level=high

  codeql:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v6
      - uses: github/codeql-action/init@v4
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v4

  codeql-actions:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v6
      - uses: github/codeql-action/init@v4
        with:
          languages: actions
      - uses: github/codeql-action/analyze@v4
```

**3 проверки:** npm audit (уязвимости в зависимостях), CodeQL TypeScript (уязвимости в коде), CodeQL Actions (supply chain атаки через workflows).

---

## 5. Dependabot: автообновление зависимостей

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10
    labels: ["dependencies"]
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    labels: ["ci"]
    groups:
      actions-minor-patch:
        update-types: ["minor", "patch"]
```

**Группировка:** minor+patch обновления в один PR (меньше шума). Major — отдельные PR.

---

## 6. SAM Template: ключевые настройки

```yaml
Globals:
  Function:
    Timeout: 30           # API Gateway hard limit
    Runtime: nodejs24.x
    MemorySize: 256

Parameters:
  ClientSecret:
    Type: String
    NoEcho: true          # скрыть в CloudFormation console

Resources:
  McpFunction:
    Properties:
      AutoPublishAlias: live                  # alias "live" → latest version
      ReservedConcurrentExecutions: 50        # cap concurrent invocations
```

| Настройка | Зачем |
|-----------|-------|
| `AutoPublishAlias: live` | Каждый deploy создает новую версию, alias `live` переключается |
| `ReservedConcurrentExecutions: 50` | Защита от DDoS и runaway costs |
| `NoEcho: true` | Secrets не видны в CloudFormation UI/API |
| `Timeout: 30` | Совпадает с hard limit API Gateway HTTP API |

---

## Сводка: что нужно настроить

### GitHub Secrets

| Secret | Для чего |
|--------|----------|
| `NPM_TOKEN` | npm publish |
| `AWS_ROLE_ARN` | OIDC auth для AWS |
| `SAM_BUCKET` | S3 для SAM артефактов |
| `MCP_MIRO_CLIENT_ID` | OAuth proxy |
| `MCP_MIRO_CLIENT_SECRET` | OAuth proxy |
| `MIRO_TEAM_ID` | Board filtering (optional) |

### Файлы для создания

```
.github/
├── dependabot.yml
└── workflows/
    ├── ci.yml              # push/PR → test + build
    ├── publish.yml         # tag v* → npm publish
    ├── deploy-lambda.yml   # manual → SAM deploy + smoke test
    ├── mark-stable.yml     # manual → promote live → stable
    ├── rollback.yml        # manual → rollback live → stable/prev-stable
    └── security.yml        # push/PR/weekly → audit + CodeQL
```

### Workflow: типичный цикл

```
1. Разработка → push → CI (auto)
2. Готово к релизу → npm version patch → push --tags → Publish (auto)
3. Деплой → workflow_dispatch Deploy → smoke test (auto)
4. Проверили в production → workflow_dispatch Mark Stable
5. Проблемы → workflow_dispatch Rollback → мгновенный откат
```
