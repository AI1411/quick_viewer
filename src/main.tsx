import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

performance.mark("app-init-start");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

window.addEventListener("load", () => {
  performance.mark("app-init-end");
  const measure = performance.measure("app-startup", "app-init-start", "app-init-end");
  console.info(`[perf] app startup: ${measure.duration.toFixed(1)}ms`);
});
