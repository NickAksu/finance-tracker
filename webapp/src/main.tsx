import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTelegramTheme, getWebApp } from "./lib/telegram";
import "./index.css";

const webApp = getWebApp();
if (webApp) {
  applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", () => applyTelegramTheme(webApp));
  webApp.ready();
  webApp.expand();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App webApp={webApp} />
  </StrictMode>,
);
