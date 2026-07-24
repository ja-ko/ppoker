import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import {
  motionTransition,
  scoreboardEntranceTiming,
  useBroadcastLayout,
} from "../animation";
import { PresenceText } from "./ui/PresenceText";

interface BroadcastHeaderProps {
  readonly displayTitle: string;
  readonly entrance?: boolean;
  readonly observed: string;
  readonly phase: "playing" | "revealed" | "status";
  readonly phaseLabel?: string;
  readonly roomCode: string;
  readonly roomName?: string;
  readonly round: number | null;
}

export function BroadcastHeader({
  displayTitle,
  entrance = false,
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
  const reducedMotion = useReducedMotion();
  const entranceEnabled = entrance && reducedMotion !== true;

  return (
    <header
      className={`scorebug${phase === "status" ? " scorebug--status" : ""}`}
    >
      {entrance ? (
        <motion.span
          animate={{ scaleX: 1 }}
          aria-hidden="true"
          className="scorebug__entrance-line"
          data-entrance="line"
          initial={entranceEnabled ? { scaleX: 0 } : false}
          transition={
            entranceEnabled
              ? {
                  duration: scoreboardEntranceTiming.lineDuration,
                  ease: [0.22, 1, 0.36, 1],
                }
              : { duration: 0 }
          }
        />
      ) : null}
      <motion.div
        animate={{ y: 0 }}
        className="brand-block"
        data-entrance="brand"
        initial={entranceEnabled ? { y: "-100%" } : false}
        transition={
          entranceEnabled
            ? {
                delay: scoreboardEntranceTiming.brandDelay,
                duration: scoreboardEntranceTiming.brandDuration,
                ease: [0.22, 1, 0.36, 1],
              }
            : { duration: 0 }
        }
      >
        <div aria-hidden="true" className="brand-mark">
          PP
        </div>
        <div className="brand-copy">
          <p>Planning poker</p>
          <strong>Live desk</strong>
        </div>
      </motion.div>

      <motion.div
        {...entranceItemMotion(0, entranceEnabled)}
        className="room-heading"
        data-entrance="room"
      >
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
      </motion.div>

      {phase === "status" ? null : (
        <>
          <dl className="broadcast-meta">
            <motion.div
              {...entranceItemMotion(1, entranceEnabled)}
              data-entrance="phase"
            >
              <dt className="type-label">Phase</dt>
              <AnimatePresence initial={false} mode="popLayout">
                <PresenceText as="dd" key={phaseLabel}>
                  {phaseLabel}
                </PresenceText>
              </AnimatePresence>
            </motion.div>
            <motion.div
              {...entranceItemMotion(2, entranceEnabled)}
              data-entrance="round"
            >
              <dt className="type-label">Round</dt>
              <AnimatePresence initial={false} mode="popLayout">
                <PresenceText as="dd" key={round ?? "none"}>
                  {round === null ? "--" : String(round).padStart(2, "0")}
                </PresenceText>
              </AnimatePresence>
            </motion.div>
            <motion.div
              {...entranceItemMotion(3, entranceEnabled)}
              data-entrance="observed"
            >
              <dt className="type-label">Observed</dt>
              <dd>{observed}</dd>
            </motion.div>
          </dl>

          <motion.div
            {...entranceItemMotion(4, entranceEnabled)}
            className="live-flag type-label"
            data-entrance="live"
          >
            <span aria-hidden="true" />
            Live
          </motion.div>
        </>
      )}
    </header>
  );
}

function entranceItemMotion(index: number, enabled: boolean) {
  return enabled
    ? {
        animate: { opacity: 1, y: 0 },
        initial: { opacity: 0, y: -18 },
        transition: {
          delay:
            scoreboardEntranceTiming.headerItemDelay +
            scoreboardEntranceTiming.headerItemStagger * index,
          duration: scoreboardEntranceTiming.headerItemDuration,
          ease: [0.22, 1, 0.36, 1] as const,
        },
      }
    : { initial: false as const };
}
