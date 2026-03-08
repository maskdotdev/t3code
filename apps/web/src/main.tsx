import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { getAppSettingsSnapshot } from "./appSettings";
import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { applyThemeToDocument, createThemeSnapshot } from "./theme";

const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);
const appSettingsSnapshot = getAppSettingsSnapshot();

document.title = APP_DISPLAY_NAME;
applyThemeToDocument(
  createThemeSnapshot({
    appearanceMode: appSettingsSnapshot.appearanceMode,
    appearanceTheme: appSettingsSnapshot.appearanceTheme,
  }),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
