import { AnimatePresence, motion, type MotionStyle } from "motion/react";

import {
  contentSwapMotion,
  motionTransition,
  participantCardLayoutId,
  useBroadcastLayout,
  useBroadcastPresence,
} from "../animation";
import type {
  PlayingParticipant,
  RevealedParticipant,
} from "../scoreboard-model";

type ParticipantGridProps =
  | {
      readonly participants: readonly PlayingParticipant[];
      readonly phase: "playing";
    }
  | {
      readonly participants: readonly RevealedParticipant[];
      readonly phase: "revealed";
    };

type ParticipantCardProps =
  | {
      readonly index: number;
      readonly layoutEnabled: boolean;
      readonly participant: PlayingParticipant;
      readonly phase: "playing";
    }
  | {
      readonly index: number;
      readonly layoutEnabled: boolean;
      readonly participant: RevealedParticipant;
      readonly phase: "revealed";
    };

type ParticipantGridStyle = MotionStyle & {
  "--participant-columns": number;
  "--participant-mobile-columns": number;
  "--participant-mobile-rows": number;
  "--participant-rows": number;
};

// Above this limit, the final slot summarizes everyone omitted from the grid.
export const PARTICIPANT_CARD_LIMIT = 12;

function SlotNumber({ index }: { readonly index: number }) {
  return (
    <span aria-hidden="true" className="slot-number">
      {String(index + 1).padStart(2, "0")}
    </span>
  );
}

function ParticipantCard(props: ParticipantCardProps) {
  const { participant } = props;
  const layoutId = participantCardLayoutId(participant.id);
  const playing = props.phase === "playing";
  const className = playing
    ? `participant-card participant-card--${props.participant.locked ? "locked" : "thinking"}`
    : `participant-card participant-card--revealed${props.participant.special === true ? " participant-card--special" : ""}`;
  const stateLabel = playing
    ? props.participant.locked
      ? "Locked"
      : "Thinking"
    : props.participant.vote;
  const stateMotion = useBroadcastPresence(contentSwapMotion);

  return (
    <motion.li
      aria-label={`${participant.name}: ${stateLabel}`}
      className={className}
      data-motion-key={layoutId}
      data-participant-id={participant.id}
      layout={props.layoutEnabled}
      {...(props.layoutEnabled ? { layoutId } : {})}
      transition={{ layout: motionTransition.layout }}
    >
      <SlotNumber index={props.index} />
      <AnimatePresence initial={false} mode="popLayout">
        {playing ? (
          <motion.div
            {...stateMotion}
            aria-hidden="true"
            className="card-state"
            key={`playing:${props.participant.locked ? "locked" : "thinking"}`}
          >
            <span className="hidden-card" />
            <strong>{stateLabel}</strong>
          </motion.div>
        ) : (
          <motion.strong
            {...stateMotion}
            aria-hidden="true"
            className="participant-vote"
            key={`revealed:${props.participant.vote}`}
          >
            {props.participant.vote}
          </motion.strong>
        )}
      </AnimatePresence>
      <motion.span
        aria-hidden="true"
        className="participant-name"
        layout={props.layoutEnabled ? "position" : false}
        transition={motionTransition.layout}
      >
        {participant.name}
      </motion.span>
    </motion.li>
  );
}

function OverflowCard({
  count,
  layoutEnabled,
}: {
  readonly count: number;
  readonly layoutEnabled: boolean;
}) {
  const layoutId = participantCardLayoutId("overflow");
  const countMotion = useBroadcastPresence(contentSwapMotion);

  return (
    <motion.li
      aria-label={`${count.toString()} more participants`}
      className="participant-card participant-card--overflow"
      data-motion-key={layoutId}
      layout={layoutEnabled}
      {...(layoutEnabled ? { layoutId } : {})}
      transition={{ layout: motionTransition.layout }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.strong
          {...countMotion}
          aria-hidden="true"
          className="participant-overflow-count"
          key={count}
        >
          +{count}
        </motion.strong>
      </AnimatePresence>
      <span aria-hidden="true" className="participant-name">
        More participants
      </span>
    </motion.li>
  );
}

export function ParticipantGrid(props: ParticipantGridProps) {
  const layoutEnabled = useBroadcastLayout();
  const count = props.participants.length;
  const hasOverflow = count > PARTICIPANT_CARD_LIMIT;
  const detailedCount = hasOverflow ? PARTICIPANT_CARD_LIMIT - 1 : count;
  const visibleCount = detailedCount + (hasOverflow ? 1 : 0);
  const overflowCount = count - detailedCount;
  const rows = Math.max(1, Math.ceil(visibleCount / 5));
  const mobileColumns = 2;
  const style: ParticipantGridStyle = {
    "--participant-columns": 5,
    "--participant-mobile-columns": mobileColumns,
    "--participant-mobile-rows": Math.max(
      1,
      Math.ceil(visibleCount / mobileColumns),
    ),
    "--participant-rows": rows,
  };
  const participantCards =
    props.phase === "playing"
      ? props.participants
          .slice(0, detailedCount)
          .map((participant, index) => (
            <ParticipantCard
              index={index}
              key={`participant:${participant.id}`}
              layoutEnabled={layoutEnabled}
              participant={participant}
              phase="playing"
            />
          ))
      : props.participants
          .slice(0, detailedCount)
          .map((participant, index) => (
            <ParticipantCard
              index={index}
              key={`participant:${participant.id}`}
              layoutEnabled={layoutEnabled}
              participant={participant}
              phase="revealed"
            />
          ));

  return (
    <motion.ol
      className={`participant-grid participant-grid--${props.phase}${rows >= 3 ? " participant-grid--dense" : ""}`}
      layout={layoutEnabled}
      style={style}
      transition={{ layout: motionTransition.layout }}
    >
      {participantCards}
      {hasOverflow ? (
        <OverflowCard
          count={overflowCount}
          key="summary:participant-overflow"
          layoutEnabled={layoutEnabled}
        />
      ) : null}
    </motion.ol>
  );
}
