# 部署指南

这些文件用于将应用部署到 Railway 或其他容器化平台。

## 文件说明

- `apps/api/Dockerfile`: FastAPI 后端服务的 Docker 镜像
- `apps/agent-runtime/Dockerfile`: Node.js Pi sidecar 的 Docker 镜像
- `apps/web/Dockerfile`: React 前端的 Docker 镜像（使用 nginx 提供服务）
- `apps/web/nginx.conf`: nginx 配置文件
- `railway-*.toml`: Railway 平台的服务配置文件
- `DEPLOY.md`: 详细的部署指南

## 快速开始

查看 [DEPLOY.md](./DEPLOY.md) 获取完整的 Railway 部署指南。

## 本地 Docker 测试

```bash
# 构建 API
docker build -f apps/api/Dockerfile -t investment-advisor-api .

# 构建 Agent Runtime
docker build -f apps/agent-runtime/Dockerfile -t investment-advisor-agent .

# 构建 Web
docker build -f apps/web/Dockerfile -t investment-advisor-web .
```

## 环境变量

详见 `.env.example` 和 `DEPLOY.md`。
