import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { startBroadcastClient } from "./bootstrap";
import { BillboardStatus } from "./components/BillboardStatus";
import { parseBroadcastConfig } from "./config";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Root element not found");
}

const reactRoot = createRoot(root);
const render = (children: React.ReactNode): void => {
  reactRoot.render(<StrictMode>{children}</StrictMode>);
};
const configResult = parseBroadcastConfig(
  import.meta.env.VITE_PPOKER_ENDPOINT,
  window.location.search,
);

if (!configResult.ok) {
  const noRoom = configResult.error.code === "missing-room";
  render(
    <BillboardStatus
      announcementRole="alert"
      detail={configResult.error.message}
      eyebrow={noRoom ? "Room selection" : "Build configuration"}
      phaseLabel={noRoom ? "No room" : "Configuration"}
      title={noRoom ? "No room selected" : "Invalid scoreboard configuration"}
    />,
  );
} else {
  const { config } = configResult;
  const bootstrap = startBroadcastClient(
    {
      render,
      unmount: () => {
        reactRoot.unmount();
      },
    },
    config,
    {
      pageTarget: window,
      reload: () => {
        window.location.reload();
      },
    },
  );

  if (import.meta.hot !== undefined) {
    import.meta.hot.dispose(() => {
      bootstrap.dispose();
    });
  }
}
