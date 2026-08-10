import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

// Redirect frontend console logs to Rust stdout for remote debugging
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog(...args);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  invoke('log_from_frontend', { level: 'info', message: msg }).catch(() => {});
};

console.error = (...args) => {
  originalError(...args);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  invoke('log_from_frontend', { level: 'error', message: msg }).catch(() => {});
};

console.warn = (...args) => {
  originalWarn(...args);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  invoke('log_from_frontend', { level: 'warn', message: msg }).catch(() => {});
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
