# Tushare 自定义 API URL 设计

## 目标

让 Python 行情 Provider 使用当前 Token 所属服务的自定义 Tushare API 地址，
同时保留未配置地址时使用官方默认地址的兼容行为。

## 设计

`TushareMarketProvider` 新增可选 `api_url` 参数，并按“构造参数优先、
`TUSHARE_API_URL` 环境变量其次”的顺序解析。创建真实 Tushare SDK 客户端后，
仅在地址非空时设置 SDK 的 `_DataApi__http_url`。注入测试客户端时不修改客户端，
避免影响现有离线测试。

本地 `.env` 配置 `TUSHARE_API_URL=https://ts.gyzcloud.top/api`。README 说明
Token 与 API 地址必须来自同一服务。

## 验证

- 单元测试验证环境变量和显式参数均能设置 SDK 地址。
- 现有 Provider、API 和缠论测试继续通过。
- 重启 Python API 后，调用昂利康 `002940.SZ` 日线分析接口，确认返回真实行情和
  缠论快照。
