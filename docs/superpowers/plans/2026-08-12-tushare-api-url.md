# Tushare Custom API URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Tushare Provider 使用可配置的自定义 API 地址并完成昂利康真实验证。

**Architecture:** Provider 负责读取 `TUSHARE_API_URL` 并在创建真实 SDK
客户端后应用地址。测试通过替换 `tushare` 模块捕获客户端，避免网络依赖。

**Tech Stack:** Python、Tushare SDK、pytest、FastAPI、uv

---

## Task 1: Provider 配置测试

**Files:**

- Modify: `tests/api/test_tushare_provider.py`

- [ ] 新增环境变量配置自定义 URL 的测试。
- [ ] 新增显式参数覆盖环境变量的测试。
- [ ] 运行定向测试并确认当前实现失败。

## Task 2: Provider 最小实现

**Files:**

- Modify: `apps/api/app/providers/tushare.py`

- [ ] 新增可选 `api_url` 参数。
- [ ] 创建真实 SDK 客户端后应用非空 URL。
- [ ] 运行定向测试并确认通过。

## Task 3: 本地配置与文档

**Files:**

- Modify: `.env`
- Modify: `README.md`

- [ ] 配置 `TUSHARE_API_URL=https://ts.gyzcloud.top/api`。
- [ ] 更新环境变量说明和数据链路描述。
- [ ] 运行 markdownlint。

## Task 4: 回归与真实验证

**Files:**

- Test: `tests/api`

- [ ] 运行 Python 测试和 Ruff。
- [ ] 重启 Python API。
- [ ] 请求昂利康 `002940.SZ` 日线分析接口。
- [ ] 校验行情条数、数据质量与缠论引擎版本。
