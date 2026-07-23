import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useIsPresent,
} from "motion/react";
import { forwardRef, useId } from "react";

import {
  contentSwapMotion,
  motionTransition,
  PARTICIPANT_PANEL_LAYOUT_ID,
  phasePanelMotion,
  useBroadcastLayout,
  useBroadcastPresence,
} from "./animation";
import { BroadcastHeader } from "./components/BroadcastHeader";
import { JoinPanel } from "./components/JoinPanel";
import { ParticipantGrid } from "./components/ParticipantGrid";
import { RoundHistory } from "./components/RoundHistory";
import { VoteDistribution } from "./components/VoteDistribution";
import { Panel } from "./components/ui/Panel";
import { PresenceText } from "./components/ui/PresenceText";
import { SectionLabel } from "./components/ui/SectionLabel";
import type {
  BroadcastScoreboardModel,
  PlayingBroadcast,
  RoundResult,
} from "./scoreboard-model";

interface BroadcastScoreboardProps {
  readonly scoreboard: BroadcastScoreboardModel;
}

function ResponseTally({
  scoreboard,
}: {
  readonly scoreboard: PlayingBroadcast;
}) {
  const locked = scoreboard.participants.filter(
    (participant) => participant.locked,
  ).length;
  const total = scoreboard.participants.length;

  return (
    <div className="response-tally">
      <div aria-hidden="true" className="response-count">
        <AnimatePresence initial={false} mode="popLayout">
          <PresenceText
            as="strong"
            hiddenFromAccessibility
            key={`locked:${locked.toString()}`}
          >
            {locked}
          </PresenceText>
        </AnimatePresence>
        <span>/{total}</span>
      </div>
      <p className="type-meta">Responses locked</p>
      <div
        aria-label={`${locked.toString()} of ${total.toString()} responses locked`}
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={locked}
        className="tally-track"
        role="progressbar"
      >
        {scoreboard.participants.map((participant) => (
          <motion.span
            animate={{
              opacity: participant.locked ? 1 : 0.48,
              scaleY: participant.locked ? 1 : 0.55,
            }}
            className={participant.locked ? "locked" : undefined}
            initial={false}
            key={`participant:${participant.id}`}
            transition={motionTransition.support}
          />
        ))}
      </div>
    </div>
  );
}

function PreviousRoundContent({
  result,
}: {
  readonly result: RoundResult | undefined;
}) {
  if (result === undefined) {
    return (
      <div className="previous-round-empty">
        <SectionLabel>Previous round</SectionLabel>
        <h2 id="previous-round-empty-title">Awaiting first result</h2>
        <p className="type-supporting">
          The first completed round will appear here after reveal.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="previous-round-summary">
        <SectionLabel>Previous round / final</SectionLabel>
        <div className="previous-score">
          <div>
            <h2 id="previous-round-title">
              Round {String(result.round).padStart(2, "0")}
            </h2>
            <p className="type-supporting">
              <time aria-label={`Observed ${result.observedAt}`}>
                Observed {result.observedAt}
              </time>
            </p>
          </div>
          <div className="previous-average">
            <strong>{result.average}</strong>
            <span className="type-meta">Avg points</span>
          </div>
        </div>
        <p className="previous-round-note type-supporting">
          <strong>
            {result.leadingCount} of {result.responseCount}
          </strong>{" "}
          on the leading card
        </p>
      </div>

      <VoteDistribution
        distribution={result.distribution}
        meta={`${result.responseCount.toString()} responses`}
        title="Final distribution"
        titleId="previous-distribution-title"
        variant="compact"
      />
    </>
  );
}

function FinalTallyContent({ scoreboard }: BroadcastScoreboardProps) {
  if (scoreboard.phase !== "revealed") {
    return null;
  }
  const { result } = scoreboard;

  return (
    <>
      <div className="result-copy">
        <SectionLabel>{`Round ${scoreboard.round.toString()} / final tally`}</SectionLabel>
        <p className="result-kicker type-label">Team estimate</p>
        <div className="average-lockup">
          <AnimatePresence initial={false} mode="popLayout">
            <PresenceText
              as="span"
              className="average-value"
              key={`average:${result.average}`}
            >
              {result.average}
            </PresenceText>
          </AnimatePresence>
          <span className="average-unit type-meta">
            Avg
            <br />
            points
          </span>
        </div>
        <p className="result-note type-supporting">
          <strong>
            {result.leadingCount} of {result.responseCount}
          </strong>{" "}
          on the leading card
        </p>
      </div>

      <VoteDistribution
        distribution={result.distribution}
        meta={`${result.numericResponses.toString()} numeric / ${result.specialResponses.toString()} special`}
        title="Vote distribution"
        titleId="distribution-title"
      />
    </>
  );
}

const ParticipantHeading = forwardRef<HTMLDivElement, BroadcastScoreboardProps>(
  function ParticipantHeading({ scoreboard }, ref) {
    const headingMotion = useBroadcastPresence(contentSwapMotion);
    const isPresent = useIsPresent();

    return scoreboard.phase === "playing" ? (
      <motion.div
        {...headingMotion}
        aria-hidden={isPresent ? undefined : true}
        className="playing-heading"
        ref={ref}
      >
        <div className="playing-title">
          <SectionLabel>{`Round ${scoreboard.round.toString()} / live vote`}</SectionLabel>
          <div className="playing-title-line">
            <h2 id="playing-title">Cards in play</h2>
            <span className="phase-chip type-meta">
              <span aria-hidden="true" />
              Voting open
            </span>
          </div>
          <p className="type-supporting">
            Estimates stay hidden until every card is in.
          </p>
        </div>
        <ResponseTally scoreboard={scoreboard} />
      </motion.div>
    ) : (
      <motion.div
        {...headingMotion}
        aria-hidden={isPresent ? undefined : true}
        className="lineup-heading"
        ref={ref}
      >
        <div>
          <SectionLabel>Starting lineup</SectionLabel>
          <h2 id="lineup-title">Participant cards</h2>
        </div>
        <p className="type-meta">
          <strong>{scoreboard.result.responseCount}</strong> responses revealed
        </p>
      </motion.div>
    );
  },
);

function ParticipantPanel({ scoreboard }: BroadcastScoreboardProps) {
  const playing = scoreboard.phase === "playing";
  const layoutEnabled = useBroadcastLayout();

  return (
    <Panel
      accent="ice"
      accentPlacement={playing ? "full-width" : "top-right"}
      aria-labelledby={playing ? "playing-title" : "lineup-title"}
      className={playing ? "playing-panel" : "lineup-panel"}
      data-motion-key={PARTICIPANT_PANEL_LAYOUT_ID}
      layout={layoutEnabled}
      {...(layoutEnabled ? { layoutId: PARTICIPANT_PANEL_LAYOUT_ID } : {})}
      transition={{ layout: motionTransition.layout }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <ParticipantHeading key={scoreboard.phase} scoreboard={scoreboard} />
      </AnimatePresence>

      {scoreboard.phase === "playing" ? (
        <ParticipantGrid
          participants={scoreboard.participants}
          phase="playing"
        />
      ) : (
        <ParticipantGrid
          participants={scoreboard.participants}
          phase="revealed"
        />
      )}
    </Panel>
  );
}

function PhasePanel({ scoreboard }: BroadcastScoreboardProps) {
  const playing = scoreboard.phase === "playing";
  const hasPreviousResult = playing && scoreboard.previousRound !== undefined;
  const finalMotion = useBroadcastPresence(phasePanelMotion.final);
  const layoutEnabled = useBroadcastLayout();
  const previousMotion = useBroadcastPresence(phasePanelMotion.previous);

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {playing ? (
        <Panel
          {...previousMotion}
          accent="vermilion"
          accentPlacement="top-right"
          aria-labelledby={
            hasPreviousResult
              ? "previous-round-title"
              : "previous-round-empty-title"
          }
          className={`phase-panel previous-round-panel${hasPreviousResult ? "" : " previous-round-panel--empty"}`}
          data-motion-key="broadcast:previous-round-panel"
          key="previous-round-panel"
          layout={layoutEnabled}
          transition={{ layout: motionTransition.layout }}
        >
          <PreviousRoundContent result={scoreboard.previousRound} />
        </Panel>
      ) : (
        <Panel
          {...finalMotion}
          accent="ice"
          accentPlacement="top-right"
          aria-labelledby="distribution-title"
          className="phase-panel result-panel"
          data-motion-key="broadcast:final-tally-panel"
          key="final-tally-panel"
          layout={layoutEnabled}
          transition={{ layout: motionTransition.layout }}
        >
          <FinalTallyContent scoreboard={scoreboard} />
        </Panel>
      )}
    </AnimatePresence>
  );
}

export function BroadcastScoreboard({ scoreboard }: BroadcastScoreboardProps) {
  const layoutGroupId = useId();
  const layoutEnabled = useBroadcastLayout();

  return (
    <LayoutGroup id={layoutGroupId}>
      <div className={`app-shell app-shell--${scoreboard.phase}`}>
        <BroadcastHeader
          displayTitle={scoreboard.displayTitle}
          observed={scoreboard.observed}
          phase={scoreboard.phase}
          roomCode={scoreboard.roomCode}
          roomName={scoreboard.roomName}
          round={scoreboard.round}
        />
        <p
          aria-atomic="true"
          className="live-announcement visually-hidden"
          role="status"
        >
          {scoreboard.phase === "playing"
            ? `Round ${scoreboard.round.toString()}. Voting open. ${scoreboard.participants.filter((participant) => participant.locked).length.toString()} of ${scoreboard.participants.length.toString()} responses locked.`
            : `Round ${scoreboard.round.toString()}. Cards revealed. ${scoreboard.result.responseCount.toString()} responses revealed.`}
        </p>

        <main className="broadcast-main">
          <div className="primary-column">
            <ParticipantPanel scoreboard={scoreboard} />
            <PhasePanel scoreboard={scoreboard} />
          </div>

          <motion.aside
            aria-label="Room access and round history"
            className="side-column"
            layout={layoutEnabled}
            transition={{ layout: motionTransition.layout }}
          >
            <JoinPanel
              roomCode={scoreboard.roomCode}
              roomName={scoreboard.roomName}
            />
            <RoundHistory history={scoreboard.history} />
          </motion.aside>
        </main>
      </div>
    </LayoutGroup>
  );
}
