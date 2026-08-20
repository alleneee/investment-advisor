# Web API Connectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本地前端连接真实 FastAPI，并通过浏览器完成昂利康验证。

**Architecture:** Vite 从项目根目录加载前端 API 环境变量，FastAPI 为本地前端
开放受限 CORS。现有 mock API 保留给单元测试显式注入，不改变业务组件。

**Tech Stack:** React、Vite、TypeScript、FastAPI、pytest、Vitest

---

## Task 1: FastAPI CORS

**Files:**

- Modify: `tests/api/test_api.py`
- Modify: `apps/api/app/main.py`

- [ ] 写本地前端 OPTIONS 预检失败测试。
- [ ] 运行测试并确认当前返回 405。
- [ ] 增加受限 CORS 中间件。
- [ ] 运行测试并确认通过。

## Task 2: Vite 根环境变量

**Files:**

- Create: `apps/web/src/vite-config.test.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `.env`

- [ ] 写 `envDir` 配置失败测试。
- [ ] 运行测试并确认当前配置缺失。
- [ ] 配置根环境目录和真实 API 地址。
- [ ] 运行测试并确认通过。

## Task 3: 文档与回归

**Files:**

- Modify: `README.md`

- [ ] 更新本地联调和 CORS 说明。
- [ ] 运行 Python、前端测试、类型检查、构建和 Markdown 校验。

## Task 4: 浏览器真实验证

**Files:**

- Test: running services on ports 5173 and 8000

- [ ] 重启 Python API 和 Vite。
- [ ] 验证 Vite 已注入 `VITE_API_BASE_URL`。
- [ ] 使用 Chrome DevTools 检查真实 API 请求和页面数据。
- [ ] 使用昂利康 `002940.SZ` 验证分析报告。
