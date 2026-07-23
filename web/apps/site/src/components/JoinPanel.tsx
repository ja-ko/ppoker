import { motionTransition, useBroadcastLayout } from "../animation";
import { Panel } from "./ui/Panel";
import { SectionLabel } from "./ui/SectionLabel";

interface JoinPanelProps {
  readonly roomCode: string;
  readonly roomName: string;
}

function PseudoQrPreview() {
  const size = 25;
  const modules = Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size);
    const column = index % size;
    const origins = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const;
    const finder = origins.find(
      ([top, left]) =>
        row >= top && row < top + 7 && column >= left && column < left + 7,
    );

    if (finder !== undefined) {
      const localRow = row - finder[0];
      const localColumn = column - finder[1];
      return (
        localRow === 0 ||
        localRow === 6 ||
        localColumn === 0 ||
        localColumn === 6 ||
        (localRow >= 2 && localRow <= 4 && localColumn >= 2 && localColumn <= 4)
      );
    }

    const separator =
      (row <= 7 && column <= 7) ||
      (row <= 7 && column >= size - 8) ||
      (row >= size - 8 && column <= 7);
    if (separator) {
      return false;
    }
    if (row === 6 || column === 6) {
      return (row + column) % 2 === 0;
    }

    return (row * 3 + column * 5 + row * column + (row ^ column) * 7) % 13 < 6;
  });

  return (
    <svg
      aria-hidden="true"
      className="qr-code"
      focusable="false"
      viewBox="0 0 29 29"
    >
      <rect width="29" height="29" fill="#f4f8f7" />
      {modules.map((filled, index) =>
        filled ? (
          <rect
            fill="#071014"
            height="1"
            key={index}
            shapeRendering="crispEdges"
            width="1"
            x={(index % size) + 2}
            y={Math.floor(index / size) + 2}
          />
        ) : null,
      )}
    </svg>
  );
}

export function JoinPanel({ roomCode, roomName }: JoinPanelProps) {
  const layoutEnabled = useBroadcastLayout();

  return (
    <Panel
      accent="vermilion"
      accentPlacement="full-width"
      aria-label="Room access preview"
      className="join-panel"
      layout={layoutEnabled}
      transition={{ layout: motionTransition.layout }}
    >
      <div className="join-topline">
        <SectionLabel>Room access</SectionLabel>
        <span className="open-badge type-meta">Preview</span>
      </div>
      <div className="join-content">
        <PseudoQrPreview />
        <div className="room-code">
          <span className="type-meta">Live room</span>
          <strong title={roomName}>{roomName}</strong>
        </div>
        <p className="join-preview-note type-supporting">
          Join code coming soon / URL room {roomCode}
        </p>
      </div>
    </Panel>
  );
}
