import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import { bindSessionsToRouter, createSiteRoutes } from "./app-router";
import { createBroadcastSessionManager } from "./broadcast-session";
import { createVotingSessionManager } from "./voting-session";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Root element not found");
}

const pageDependencies = {
  pageTarget: window,
  reload: () => {
    window.location.reload();
  },
};
const broadcastSessions = createBroadcastSessionManager(pageDependencies);
const votingSessions = createVotingSessionManager(pageDependencies);
const router = createBrowserRouter(
  createSiteRoutes({
    broadcastSessions,
    endpoint: import.meta.env.VITE_PPOKER_ENDPOINT,
    votingSessions,
  }),
);
const unbindRouter = bindSessionsToRouter(router, {
  broadcast: broadcastSessions,
  voting: votingSessions,
});
const reactRoot = createRoot(root);
reactRoot.render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => {
    unbindRouter();
    broadcastSessions.dispose();
    votingSessions.dispose();
    router.dispose();
    reactRoot.unmount();
  });
}
