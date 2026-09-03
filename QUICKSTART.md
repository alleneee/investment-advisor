# 快速部署方案

## 选项 1: Gitpod 在线运行（推荐用于快速测试）

点击下方按钮在 Gitpod 中启动完整应用栈：

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/alleneee/investment-advisor/tree/cursor/deploy-to-railway-02bd)

Gitpod 会自动：
- 启动 PostgreSQL 数据库
- 启动 FastAPI 后端（端口 8000）
- 启动 Node.js Agent Runtime（端口 8081）
- 启动 React 前端（端口 5173）

访问前端 URL（Gitpod 会自动打开），即可使用应用。

**注意**: Gitpod 免费计划提供每月 50 小时的使用时间。

## 选项 2: Railway 部署（生产环境）

详细步骤请查看 [DEPLOY.md](./DEPLOY.md)

1. Fork 或克隆本仓库
2. 访问 [Railway](https://railway.app/)
3. 创建新项目并连接 GitHub 仓库
4. 添加 PostgreSQL 数据库
5. 分别创建 API、Agent Runtime 和 Web 服务
6. 配置环境变量

## 选项 3: Docker Compose（本地/自建服务器）

```bash
# 克隆仓库
git clone https://github.com/alleneee/investment-advisor.git
cd investment-advisor
git checkout cursor/deploy-to-railway-02bd

# 创建 .env 文件
cat > .env <<EOF
DB_PASSWORD=changeme
INTERNAL_AGENT_TOKEN=$(openssl rand -hex 32)
VITE_API_BASE_URL=http://localhost:8000
EOF

# 启动所有服务
docker compose up -d

# 查看日志
docker compose logs -f

# 访问应用
# Web: http://localhost
# API: http://localhost:8000
# Health: http://localhost:8000/health
```

## 选项 4: Fly.io 部署

需要 Fly.io 账户和 flyctl CLI：

```bash
# 登录 Fly.io
flyctl auth login

# 部署数据库
flyctl postgres create --name investment-advisor-db

# 部署 API
cd /path/to/investment-advisor
flyctl launch --config fly-api.toml
flyctl secrets set DATABASE_URL="postgres://..." INTERNAL_AGENT_TOKEN="$(openssl rand -hex 32)"

# 部署 Agent Runtime
flyctl launch --config fly-agent.toml
flyctl secrets set INTERNAL_AGENT_TOKEN="..." PYTHON_API_BASE_URL="https://investment-advisor-api.fly.dev"

# 部署 Web
flyctl launch --config fly-web.toml
```

## 功能说明

### 无需配置即可使用
- ✅ 前端 UI 界面
- ✅ 基础 API 功能
- ✅ 数据库存储

### 需要 API Keys 的功能
- ❌ **真实 A 股行情数据**: 需要配置 `TUSHARE_TOKEN` 或 `HITHINK_FINANCE_API_KEY`
- ❌ **AI 投研报告**: 需要配置 `PI_PROVIDER`、`PI_MODEL`、`PI_API_KEY`
- ❌ **市场资讯**: 需要行情数据 API Keys

没有这些 Keys 时，应用仍可正常运行，但会使用降级模式或返回相应的错误提示。

## 获取 API Keys

- **Tushare**: 在 [tushare.pro](https://tushare.pro/) 注册并获取 token
- **同花顺金融数据**: 在 [扶摇 API](https://fuyao.aicubes.cn/) 申请
- **AI 模型**: 使用 OpenAI 兼容的服务（如 New API、DeepSeek 等）

## 故障排除

详见 [DEPLOY.md](./DEPLOY.md) 中的故障排除部分。
