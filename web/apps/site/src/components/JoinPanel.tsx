import { encode } from "uqr";
import { memo, useMemo } from "react";

import { motionTransition, useBroadcastLayout } from "../animation";
import { buildVotingUrl, type VotingUrlBase } from "../voting/voting-url";
import { Panel } from "./ui/Panel";
import { PanelHeader } from "./ui/PanelHeader";

interface JoinPanelProps {
  readonly roomCode: string;
  readonly roomName: string;
  readonly baseUrl?: VotingUrlBase;
  readonly voterUrl?: string;
}

const VotingQr = memo(function VotingQr({
  roomName,
  voterUrl,
}: {
  roomName: string;
  voterUrl: string;
}) {
  const qr = useMemo(() => {
    const encoded = encode(voterUrl, { border: 4, ecc: "M" });
    const modulePath = encoded.data
      .flatMap((row, rowIndex) =>
        row.flatMap((filled, columnIndex) =>
          filled ? [`M${String(columnIndex)} ${String(rowIndex)}h1v1h-1z`] : [],
        ),
      )
      .join("");

    return { modulePath, size: encoded.size };
  }, [voterUrl]);

  return (
    <svg
      aria-label={`QR code to join ${roomName}`}
      className="qr-code"
      focusable="false"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
    >
      <title>{`QR code to join ${roomName}`}</title>
      <rect fill="#ffffff" height={qr.size} width={qr.size} />
      <path d={qr.modulePath} data-qr-modules="" fill="#000000" />
    </svg>
  );
});

export function JoinPanel({
  baseUrl,
  roomCode,
  roomName,
  voterUrl,
}: JoinPanelProps) {
  const layoutEnabled = useBroadcastLayout();
  const resolvedVoterUrl =
    voterUrl ?? buildVotingUrl(roomCode, baseUrl ?? window.location);

  return (
    <Panel
      accent="vermilion"
      accentPlacement="full-width"
      aria-label="Room access"
      className="join-panel"
      layout={layoutEnabled}
      transition={{ layout: motionTransition.layout }}
    >
      <PanelHeader
        trailing={<span className="open-badge type-meta">Scan to join</span>}
      >
        Room access
      </PanelHeader>
      <div className="join-content">
        <a aria-label={`Join ${roomName} voting room`} href={resolvedVoterUrl}>
          <VotingQr roomName={roomName} voterUrl={resolvedVoterUrl} />
        </a>
        <div className="room-code">
          <span className="type-meta">Live room</span>
          <strong title={roomName}>{roomName}</strong>
        </div>
        <p className="join-preview-note type-supporting">
          Scan or select the QR code to join room {roomCode}
        </p>
      </div>
    </Panel>
  );
}
