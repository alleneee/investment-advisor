import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHttpApi } from "./api";
import { createTradingApi } from "./trading-api";

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function resolveApiBaseUrl(): string | undefined {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (import.meta.env.DEV) {
    return configured || "http://127.0.0.1:8000";
  }
  if (configured && !isLoopbackUrl(configured)) {
    return configured.replace(/\/$/, "");
  }
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin;
  }
  return configured;
}

const apiBaseUrl = resolveApiBaseUrl();
const api = apiBaseUrl ? createHttpApi(apiBaseUrl) : undefined;
const tradingApi = apiBaseUrl ? createTradingApi(apiBaseUrl) : undefined;

createRoot(document.getElementById("root")!).render(<StrictMode><App api={api} tradingApi={tradingApi} /></StrictMode>);
