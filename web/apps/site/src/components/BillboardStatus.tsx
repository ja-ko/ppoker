import { BILLBOARD_TITLE_PLACEHOLDER } from "../config";
import { BroadcastHeader } from "./BroadcastHeader";
import { Panel } from "./ui/Panel";
import { PanelHeader } from "./ui/PanelHeader";

interface BillboardStatusProps {
  readonly announcementRole?: "alert" | "status";
  readonly detail: string;
  readonly eyebrow: string;
  readonly phaseLabel: string;
  readonly roomCode?: string;
  readonly title: string;
}

export function BillboardStatus({
  announcementRole = "status",
  detail,
  eyebrow,
  phaseLabel,
  roomCode = "Not selected",
  title,
}: BillboardStatusProps) {
  return (
    <div className="app-shell app-shell--status">
      <BroadcastHeader
        displayTitle={BILLBOARD_TITLE_PLACEHOLDER}
        observed="--:--"
        phase="status"
        phaseLabel={phaseLabel}
        roomCode={roomCode}
        round={null}
      />
      <main className="status-main">
        <Panel
          accent="ice"
          accentPlacement="full-width"
          aria-labelledby="billboard-status-title"
          className="status-panel"
          role={announcementRole}
        >
          <PanelHeader>{eyebrow}</PanelHeader>
          <h2 id="billboard-status-title">{title}</h2>
          <p className="type-supporting">{detail}</p>
        </Panel>
      </main>
    </div>
  );
}
