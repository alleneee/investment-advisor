# 前端真实 API 连通设计

## 目标

让本地 5173 前端默认读取项目根目录的 API 地址，并能够跨端口访问 8000 的
FastAPI，不再静默回退到 mock 数据。

## 设计

Vite 配置增加 `envDir: "../.."`，使 `npm --prefix apps/web run dev` 能读取项目
根目录 `.env` 中的 `VITE_API_BASE_URL`。本地配置将该值设为
`http://127.0.0.1:8000`。

FastAPI 增加 CORS 中间件，只允许本地前端的 `127.0.0.1:5173` 与
`localhost:5173` Origin，允许当前 JSON API 所需的方法和请求头。

浏览器扩展产生的 WebSocket 和动态翻译错误不属于应用代码，不在本次修改范围。

## 验证

- 后端 OPTIONS 预检测试由 405 变为 200，并返回正确 Origin。
- Vite 配置测试确认环境目录指向项目根目录。
- 重启前后端后，浏览器网络面板出现真实 `/api/watchlist` 和昂利康分析请求。
- 页面展示后端自选池中的昂利康 `002940.SZ`，控制台无业务错误。
