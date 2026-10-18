import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xterm/xterm/css/xterm.css";

import { App } from "./App";
import { cockpitApi } from "./bridge";
import { configureAppPlatform } from "../shared/i18n";
import "./styles.css";

configureAppPlatform(cockpitApi.platform);
document.documentElement.dataset.platform = cockpitApi.platform;

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Renderer root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
