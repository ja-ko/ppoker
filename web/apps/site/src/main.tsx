import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import { bindSessionToRouter, createSiteRoutes } from "./app-router";
import { createBroadcastSessionManager } from "./broadcast-session";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Root element not found");
}

const sessions = createBroadcastSessionManager({
  pageTarget: window,
  reload: () => {
    window.location.reload();
  },
});
const router = createBrowserRouter(
  createSiteRoutes({
    endpoint: import.meta.env.VITE_PPOKER_ENDPOINT,
    sessions,
  }),
);
const unbindRouter = bindSessionToRouter(router, sessions);
const reactRoot = createRoot(root);
reactRoot.render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => {
    unbindRouter();
    sessions.dispose();
    router.dispose();
    reactRoot.unmount();
  });
}
