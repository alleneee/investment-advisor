import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHttpApi } from "./api";
import { createTradingApi } from "./trading-api";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const api = apiBaseUrl
  ? createHttpApi(apiBaseUrl)
  : undefined;
const tradingApi = apiBaseUrl ? createTradingApi(apiBaseUrl) : undefined;

createRoot(document.getElementById("root")!).render(<StrictMode><App api={api} tradingApi={tradingApi} /></StrictMode>);
