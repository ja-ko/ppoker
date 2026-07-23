import { AnimatePresence, motion } from "motion/react";

import { motionTransition, useBroadcastLayout } from "../animation";
import { PresenceText } from "./ui/PresenceText";

interface BroadcastHeaderProps {
  readonly displayTitle: string;
  readonly observed: string;
  readonly phase: "playing" | "revealed" | "status";
  readonly phaseLabel?: string;
  readonly roomCode: string;
  readonly roomName?: string;
  readonly round: number | null;
}

export function BroadcastHeader({
  displayTitle,
  observed,
  phase,
  phaseLabel: statusPhaseLabel,
  roomCode,
  roomName,
  round,
}: BroadcastHeaderProps) {
  const phaseLabel =
    phase === "playing"
      ? "Voting open"
      : phase === "revealed"
        ? "Cards revealed"
        : (statusPhaseLabel ?? "Standby");
  const layoutEnabled = useBroadcastLayout();

  return (
    <header
      className={`scorebug${phase === "status" ? " scorebug--status" : ""}`}
    >
      <div className="brand-block">
        <div aria-hidden="true" className="brand-mark">
          PP
        </div>
        <div className="brand-copy">
          <p>Planning poker</p>
          <strong>Live desk</strong>
        </div>
      </div>

      <div className="room-heading">
        <p className="eyebrow type-label">
          Estimation room / {roomName === undefined ? "" : `${roomName} / `}
          {roomCode}
        </p>
        <motion.h1
          layout={layoutEnabled ? "position" : false}
          transition={motionTransition.layout}
        >
          {displayTitle}
        </motion.h1>
      </div>

      {phase === "status" ? null : (
        <>
          <dl className="broadcast-meta">
            <div>
              <dt className="type-label">Phase</dt>
              <AnimatePresence initial={false} mode="popLayout">
                <PresenceText as="dd" key={phaseLabel}>
                  {phaseLabel}
                </PresenceText>
              </AnimatePresence>
            </div>
            <div>
              <dt className="type-label">Round</dt>
              <AnimatePresence initial={false} mode="popLayout">
                <PresenceText as="dd" key={round ?? "none"}>
                  {round === null ? "--" : String(round).padStart(2, "0")}
                </PresenceText>
              </AnimatePresence>
            </div>
            <div>
              <dt className="type-label">Observed</dt>
              <dd>{observed}</dd>
            </div>
          </dl>

          <div className="live-flag type-label">
            <span aria-hidden="true" />
            Live
          </div>
        </>
      )}
    </header>
  );
}
