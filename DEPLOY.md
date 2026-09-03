# 部署指南 - Railway

本文档说明如何将投资顾问应用部署到 Railway。

## 架构概览

应用包含以下服务：
- **API** (FastAPI + Python): 后端 API 服务
- **Agent Runtime** (Node.js): Pi 智能体 sidecar
- **Web** (React + Vite): 前端界面
- **PostgreSQL**: 数据库（Railway 提供）

## Railway 部署步骤

### 1. 创建 Railway 项目

1. 访问 [Railway](https://railway.app/)
2. 点击 "New Project"
3. 选择 "Deploy from GitHub repo"
4. 选择 `alleneee/investment-advisor` 仓库
5. 选择分支 `cursor/deploy-to-railway-02bd`

### 2. 添加 PostgreSQL 数据库

1. 在项目中点击 "New"
2. 选择 "Database" -> "PostgreSQL"
3. Railway 会自动创建数据库并设置 `DATABASE_URL` 环境变量

### 3. 配置 API 服务

1. 点击 "New" -> "GitHub Repo" -> 选择此仓库
2. 在 Settings 中配置：
   - **Name**: `api`
   - **Root Directory**: 留空
   - **Dockerfile Path**: `apps/api/Dockerfile`
   - **Port**: `8000`

3. 设置环境变量（Variables）:
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
INTERNAL_AGENT_TOKEN=<生成一个随机 token，例如: $(openssl rand -hex 32)>
AGENT_RUNTIME_URL=http://agent-runtime.railway.internal:8081
CORS_ORIGINS=<Web 服务的公开 URL，部署后填写>
MARKET_PROVIDER=auto
```

可选环境变量（用于真实数据，如果没有则使用降级模式）:
```
TUSHARE_TOKEN=<你的 Tushare token>
HITHINK_FINANCE_API_KEY=<你的同花顺金融数据 API Key>
```

### 4. 配置 Agent Runtime 服务

1. 点击 "New" -> "Empty Service"
2. 在 Settings 中配置：
   - **Name**: `agent-runtime`
   - **Source**: 选择同一个 GitHub 仓库
   - **Root Directory**: 留空
   - **Dockerfile Path**: `apps/agent-runtime/Dockerfile`
   - **Port**: `8081`

3. 设置环境变量:
```
INTERNAL_AGENT_TOKEN=${{api.INTERNAL_AGENT_TOKEN}}
PYTHON_API_BASE_URL=http://api.railway.internal:8000
PI_AGENT_PORT=8081
```

可选环境变量（用于 AI 报告生成）:
```
PI_PROVIDER=new-api
PI_MODEL=glm-5.2
PI_BASE_URL=<你的 New API 服务地址>
PI_API_KEY=<你的模型 API key>
```

### 5. 配置 Web 服务

1. 点击 "New" -> "Empty Service"
2. 在 Settings 中配置：
   - **Name**: `web`
   - **Source**: 选择同一个 GitHub 仓库
   - **Root Directory**: 留空
   - **Dockerfile Path**: `apps/web/Dockerfile`
   - **Port**: `80`

3. 设置构建时环境变量:
```
VITE_API_BASE_URL=<API 服务的公开 URL，部署后填写>
```

4. 启用公开访问（Public Networking）

### 6. 更新 CORS 配置

部署完成后：
1. 获取 Web 服务的公开 URL（例如：`https://web-production-xxxx.up.railway.app`）
2. 更新 API 服务的 `CORS_ORIGINS` 环境变量为这个 URL
3. 获取 API 服务的公开 URL（例如：`https://api-production-xxxx.up.railway.app`）
4. 重新构建 Web 服务，设置 `VITE_API_BASE_URL` 为 API 的公开 URL

### 7. 验证部署

访问 Web 服务的公开 URL，应该能看到投资顾问界面。

检查服务健康状态：
- API: `https://<api-url>/health`
- Agent Runtime: `https://<agent-runtime-url>/health/live`

## 环境变量说明

### 必需变量

- `DATABASE_URL`: PostgreSQL 连接串（Railway 自动提供）
- `INTERNAL_AGENT_TOKEN`: API 和 sidecar 之间的共享 token

### 可选变量（市场数据）

- `TUSHARE_TOKEN`: Tushare API token（用于获取 A 股行情数据）
- `HITHINK_FINANCE_API_KEY`: 同花顺金融数据 API Key
- `MARKET_PROVIDER`: 数据源选择，默认 "auto"

### 可选变量（AI 功能）

- `PI_PROVIDER`: AI 提供商（例如：new-api）
- `PI_MODEL`: 模型名称（例如：glm-5.2）
- `PI_BASE_URL`: 模型 API 地址
- `PI_API_KEY`: 模型 API Key

## 功能说明

### 完全可用功能（无需额外配置）

- ✅ 前端 UI（使用 mock 数据）
- ✅ 数据库存储
- ✅ 基础 API 接口

### 需要配置才能使用的功能

- ❌ 真实 A 股行情数据（需要 `TUSHARE_TOKEN` 或 `HITHINK_FINANCE_API_KEY`）
- ❌ AI 投研报告生成（需要 `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`）
- ❌ 市场资讯（需要行情数据配置）

## 故障排除

### 服务无法启动

- 检查环境变量是否正确配置
- 查看服务日志（Railway Dashboard -> Service -> Deployments -> Logs）

### 数据库连接失败

- 确认 PostgreSQL 服务已启动
- 检查 `DATABASE_URL` 是否正确引用

### CORS 错误

- 确认 `CORS_ORIGINS` 包含 Web 服务的公开 URL
- 确认 `VITE_API_BASE_URL` 指向 API 服务的公开 URL

## 成本说明

Railway 提供免费额度（每月 $5 信用额度或 500 小时执行时间）。超出免费额度后会按使用量计费。

- PostgreSQL: ~$5/月
- 3 个服务: 根据使用量计费

对于演示目的，免费额度通常足够使用。
