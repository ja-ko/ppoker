import type { ClientSnapshot, Player, PokerClient } from "@ppoker/web-client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
} from "react";

import {
  AutoRevealController,
  createCommandIntent,
  createDrawingIntent,
  votingContextKey,
  type DrawingIntent,
  type MonotonicScheduler,
} from "./auto-reveal";
import {
  InkPad,
  PREPROCESSING_CONFIG,
  RecognitionClient,
  RecognitionFlow,
  canonicalValue,
  initialFlowDiagnostics,
  initialRecognizerStatus,
  initialVoteInputState,
  voteInputReducer,
  type FlowDiagnostics,
  type InkPadHandle,
  type RecognitionRuntime,
  type RecognitionFailureSource,
  type RecognizerStatus,
  type RejectionKind,
  type VoteInputEvent,
  type VoteInputState,
} from "./handwriting";
import {
  effectiveLocalVote,
  enqueueLocalVoteCommand,
  pendingLocalVoteIntent,
  reconcileLocalVoteCommands,
  type LocalVoteCommandQueue,
  type PendingLocalVoteIntent,
} from "./local-vote-commands";
import {
  phaseControlPolicy,
  selectVoters,
  votingCoverage,
} from "./participant-policy";
import type { VoterNameSession } from "./voter-session";

type PhaseDialog = "rename" | "reset" | "reveal" | null;
type PhasePending = "reset" | "reveal" | null;

interface ActiveDrawing {
  readonly contextKey: string;
  readonly intent: DrawingIntent;
  readonly revision: number;
}

interface OptimisticName {
  readonly contextKey: string;
  readonly revision: number;
  readonly value: string;
}

interface InkMorphGeometry {
  readonly originX: number;
  readonly originY: number;
  readonly translateX: number;
  readonly translateY: number;
}

class StaleDrawingError extends Error {
  constructor() {
    super("This drawing belongs to an inactive voting round.");
    this.name = "StaleDrawingError";
  }
}

export interface VotingRoomProps {
  readonly autoRevealScheduler?: MonotonicScheduler;
  readonly client: PokerClient;
  readonly createRecognitionRuntime?: () => RecognitionRuntime;
  readonly initialName: string;
  readonly nameSession: VoterNameSession;
  readonly roomCode: string;
  readonly snapshot: ClientSnapshot;
}

export function VotingRoom({
  autoRevealScheduler,
  client,
  createRecognitionRuntime = defaultRecognitionRuntime,
  initialName,
  nameSession,
  roomCode,
  snapshot,
}: VotingRoomProps) {
  const inkRef = useRef<InkPadHandle>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const deckRef = useRef<readonly number[]>(
    numericDeck(snapshot.room?.deck ?? []),
  );
  deckRef.current = numericDeck(snapshot.room?.deck ?? []);

  const [voteInput, setVoteInput] = useState<VoteInputState>(
    initialVoteInputState,
  );
  const voteInputRef = useRef(voteInput);
  const dispatchVoteInput = (event: VoteInputEvent): void => {
    const next = voteInputReducer(voteInputRef.current, event);
    voteInputRef.current = next;
    setVoteInput(next);
  };
  const [recognizerStatus, setRecognizerStatus] = useState<RecognizerStatus>(
    initialRecognizerStatus,
  );
  const recognizerStatusRef = useRef(recognizerStatus);
  recognizerStatusRef.current = recognizerStatus;
  const [diagnostics, setDiagnostics] = useState<FlowDiagnostics>(
    initialFlowDiagnostics,
  );
  const [voteCommands, setVoteCommands] =
    useState<LocalVoteCommandQueue | null>(null);
  const [yieldedResult, setYieldedResult] = useState(false);
  const [dialog, setDialog] = useState<PhaseDialog>(null);
  const [phasePending, setPhasePending] = useState<PhasePending>(null);
  const phasePendingRef = useRef<PhasePending>(phasePending);
  phasePendingRef.current = phasePending;
  const [commandError, setCommandError] = useState<string | null>(null);
  const [optimisticName, setOptimisticName] = useState<OptimisticName | null>(
    null,
  );
  const optimisticNameRef = useRef(optimisticName);
  optimisticNameRef.current = optimisticName;
  const voteCommandsRef = useRef(voteCommands);
  voteCommandsRef.current = voteCommands;
  const [revealMissingCount, setRevealMissingCount] = useState(0);
  const [morphGeometry, setMorphGeometry] = useState<InkMorphGeometry | null>(
    null,
  );
  const activeDrawingRef = useRef<ActiveDrawing | null>(null);
  const flowRef = useRef<RecognitionFlow | null>(null);
  const effectiveVoteRef = useRef<string | null>(null);
  const phaseActionRef = useRef<HTMLButtonElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);

  const setPending = (pending: PhasePending): void => {
    phasePendingRef.current = pending;
    setPhasePending(pending);
  };
  const reportCommandError = (error: unknown): void => {
    setPending(null);
    setCommandError(errorMessage(error));
  };
  const reportCommandErrorRef = useRef(reportCommandError);
  reportCommandErrorRef.current = reportCommandError;
  const setPendingRef = useRef(setPending);
  setPendingRef.current = setPending;

  const autoRevealRef = useRef<AutoRevealController | null>(null);
  autoRevealRef.current ??= new AutoRevealController({
    getSnapshot: client.getSnapshot,
    onRevealError: (error) => {
      reportCommandErrorRef.current(error);
    },
    ...(autoRevealScheduler === undefined
      ? {}
      : { scheduler: autoRevealScheduler }),
    sendReveal: () => {
      setPendingRef.current("reveal");
      client.reveal();
    },
  });
  const autoReveal = autoRevealRef.current;
  const autoRevealState = useSyncExternalStore(
    autoReveal.subscribe,
    autoReveal.getState,
    autoReveal.getState,
  );

  const contextKey = votingContextKey(snapshot);
  const currentVoteIntent = pendingLocalVoteIntent(voteCommands, snapshot);
  const effectiveVote = effectiveLocalVote(voteCommands, snapshot);
  effectiveVoteRef.current = effectiveVote;
  const displayVote = yieldedResult ? null : effectiveVote;
  const coverage = votingCoverage(snapshot);
  const phasePolicy = phaseControlPolicy(snapshot);
  const canVote =
    snapshot.status === "open" && snapshot.room?.phase === "playing";
  const canDraw = canVote && recognizerStatus.readiness === "ready";
  const voters = selectVoters(snapshot.room?.players ?? []);
  const responseCount = voters.filter((voter) =>
    isVoterCovered(voter, coverage.localVoter, currentVoteIntent),
  ).length;
  const authoritativeName =
    snapshot.localName.length === 0 ? initialName : snapshot.localName;
  const currentName =
    optimisticName?.contextKey === contextKey
      ? optimisticName.value
      : authoritativeName;

  const updateVoteCommands = (next: LocalVoteCommandQueue | null): void => {
    voteCommandsRef.current = next;
    setVoteCommands(next);
  };
  const enqueueVoteCommand = (
    value: string | null,
    before: ClientSnapshot,
    after: ClientSnapshot,
  ): void => {
    updateVoteCommands(
      enqueueLocalVoteCommand(voteCommandsRef.current, value, before, after),
    );
  };
  const updateOptimisticName = (next: OptimisticName | null): void => {
    optimisticNameRef.current = next;
    setOptimisticName(next);
  };

  const [countdownLabel, setCountdownLabel] = useState<number | null>(null);
  useEffect(() => {
    if (autoRevealState.status !== "counting") {
      setCountdownLabel(null);
      return;
    }
    const now = autoRevealScheduler?.now ?? (() => performance.now());
    const update = (): void => {
      setCountdownLabel(
        Math.max(1, Math.ceil((autoRevealState.deadline - now()) / 1_000)),
      );
    };
    update();
    const interval = globalThis.setInterval(update, 100);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, [autoRevealScheduler, autoRevealState]);

  const commitDrawingRef = useRef<(value: number, revision: number) => void>(
    () => undefined,
  );
  const rejectDrawingRef = useRef<
    (rejection: RejectionKind, revision: number) => void
  >(() => undefined);
  const failDrawingRef = useRef<
    (error: unknown, revision: number, source: RecognitionFailureSource) => void
  >(() => undefined);

  flowRef.current ??= new RecognitionFlow({
    dispatch: dispatchVoteInput,
    getInk: () => inkRef.current,
    getNumericDeck: () => deckRef.current,
    getRecognizerStatus: () => recognizerStatusRef.current,
    getState: () => voteInputRef.current,
    onCommit: (value, revision) => {
      commitDrawingRef.current(value, revision);
    },
    onDiagnostics: (patch) => {
      setDiagnostics((current) => ({ ...current, ...patch }));
    },
    onFailure: (error, revision, source) => {
      failDrawingRef.current(error, revision, source);
    },
    onReject: (rejection, revision) => {
      rejectDrawingRef.current(rejection, revision);
    },
  });
  const flow = flowRef.current;

  commitDrawingRef.current = (value, revision): void => {
    const drawing = activeDrawingRef.current;
    const latest = client.getSnapshot();
    if (
      drawing?.revision !== revision ||
      drawing.contextKey !== votingContextKey(latest)
    ) {
      throw new StaleDrawingError();
    }
    setMorphGeometry(inkMorphGeometry(inkRef.current));
    const valueText = String(value);
    const alreadyEffective =
      effectiveLocalVote(voteCommandsRef.current, latest) === valueText;
    const accepted = autoReveal.submitDrawingVote(
      drawing.intent,
      value,
      (nextValue) => {
        if (!alreadyEffective) {
          client.vote(String(nextValue));
        }
      },
    );
    if (!accepted) {
      throw new StaleDrawingError();
    }
    if (!alreadyEffective) {
      enqueueVoteCommand(valueText, latest, client.getSnapshot());
    }
    activeDrawingRef.current = null;
    setYieldedResult(false);
    setCommandError(null);
  };
  rejectDrawingRef.current = (_rejection, revision): void => {
    const drawing = activeDrawingRef.current;
    if (drawing?.revision !== revision) {
      return;
    }
    const latestBeforeCommand = client.getSnapshot();
    if (drawing.contextKey !== votingContextKey(latestBeforeCommand)) {
      autoReveal.rejectDrawing(drawing.intent);
      activeDrawingRef.current = null;
      setYieldedResult(false);
      return;
    }
    autoReveal.rejectDrawing(drawing.intent);
    autoReveal.cancel();
    if (effectiveVoteRef.current !== null) {
      autoReveal.retract(createCommandIntent(), () => {
        client.retractVote();
      });
      enqueueVoteCommand(null, latestBeforeCommand, client.getSnapshot());
    }
    activeDrawingRef.current = null;
    setMorphGeometry(null);
    setYieldedResult(false);
  };
  failDrawingRef.current = (error, revision, source): void => {
    const drawing = activeDrawingRef.current;
    if (source !== "inference" && drawing?.revision === revision) {
      autoReveal.rejectDrawing(drawing.intent);
      activeDrawingRef.current = null;
    }
    if (source !== "inference" && !(error instanceof StaleDrawingError)) {
      reportCommandError(error);
    }
  };

  useEffect(() => {
    autoReveal.observe(snapshot);
  }, [autoReveal, snapshot]);

  useEffect(() => {
    flow.recognitionConfigurationChanged();
  }, [flow, snapshot.room?.deck]);

  useEffect(() => {
    const runtime = createRecognitionRuntime();
    flow.setRuntime(runtime);
    const unsubscribe = runtime.subscribe((status) => {
      recognizerStatusRef.current = status;
      setRecognizerStatus(status);
      flow.recognizerStatusChanged(status);
    });
    return () => {
      unsubscribe();
      flow.setRuntime(null);
      runtime.dispose();
    };
  }, [createRecognitionRuntime, flow]);

  useEffect(() => {
    return () => {
      flow.dispose();
      autoReveal.cancel();
    };
  }, [autoReveal, flow]);

  const previousContextKeyRef = useRef(contextKey);
  useLayoutEffect(() => {
    if (previousContextKeyRef.current === contextKey) {
      return;
    }
    previousContextKeyRef.current = contextKey;
    const drawing = activeDrawingRef.current;
    if (drawing !== null) {
      autoReveal.rejectDrawing(drawing.intent);
      activeDrawingRef.current = null;
    }
    autoReveal.cancel();
    flow.clear();
    updateVoteCommands(null);
    updateOptimisticName(null);
    setMorphGeometry(null);
    setYieldedResult(false);
    setPending(null);
    setDialog(null);
  }, [autoReveal, contextKey, flow]);

  useEffect(() => {
    const reconciled = reconcileLocalVoteCommands(voteCommands, snapshot);
    if (reconciled !== voteCommands) {
      updateVoteCommands(reconciled);
    }
  }, [snapshot, voteCommands]);

  useEffect(() => {
    if (optimisticName === null) {
      return;
    }
    if (
      optimisticName.contextKey !== contextKey ||
      authoritativeName === optimisticName.value ||
      snapshot.revision > optimisticName.revision
    ) {
      updateOptimisticName(null);
    }
  }, [authoritativeName, contextKey, optimisticName, snapshot.revision]);

  const invalidateDrawing = (showAuthoritative = true): void => {
    const drawing = activeDrawingRef.current;
    if (drawing !== null) {
      autoReveal.rejectDrawing(drawing.intent);
    }
    activeDrawingRef.current = null;
    autoReveal.cancel();
    flow.clear();
    setMorphGeometry(null);
    if (showAuthoritative) {
      setYieldedResult(false);
    }
  };

  const voteForCard = (card: string): void => {
    if (!canVote) {
      return;
    }
    if (
      effectiveLocalVote(voteCommandsRef.current, client.getSnapshot()) === card
    ) {
      if (activeDrawingRef.current !== null) {
        invalidateDrawing();
      }
      return;
    }
    invalidateDrawing();
    const before = client.getSnapshot();
    try {
      const submitted = autoReveal.submitVote(createCommandIntent(), () => {
        client.vote(card);
      });
      if (!submitted) {
        return;
      }
      enqueueVoteCommand(card, before, client.getSnapshot());
      setCommandError(null);
    } catch (error: unknown) {
      reportCommandError(error);
    }
  };

  const clearVote = (): void => {
    if (
      effectiveLocalVote(voteCommandsRef.current, client.getSnapshot()) === null
    ) {
      return;
    }
    invalidateDrawing();
    const before = client.getSnapshot();
    try {
      const retracted = autoReveal.retract(createCommandIntent(), () => {
        client.retractVote();
      });
      if (retracted) {
        enqueueVoteCommand(null, before, client.getSnapshot());
        setCommandError(null);
      }
    } catch (error: unknown) {
      reportCommandError(error);
    }
  };

  const pointerAccepted = (): void => {
    const latest = client.getSnapshot();
    const latestContextKey = votingContextKey(latest);
    if (
      latestContextKey === null ||
      latest.status !== "open" ||
      latest.room?.phase !== "playing"
    ) {
      return;
    }
    const previousDrawing = activeDrawingRef.current;
    if (
      previousDrawing !== null &&
      previousDrawing.contextKey !== latestContextKey
    ) {
      autoReveal.rejectDrawing(previousDrawing.intent);
      activeDrawingRef.current = null;
    }
    const intent = autoReveal.startDrawing(
      activeDrawingRef.current?.intent ?? createDrawingIntent(),
    );
    setYieldedResult(true);
    setMorphGeometry(null);
    setCommandError(null);
    try {
      const revision = flow.pointerAccepted();
      activeDrawingRef.current = {
        contextKey: latestContextKey,
        intent,
        revision,
      };
    } catch (error: unknown) {
      autoReveal.rejectDrawing(intent);
      reportCommandError(error);
    }
  };

  const preventStaleDrawing = (): void => {
    invalidateDrawing();
  };

  const requestReveal = (): void => {
    preventStaleDrawing();
    sendReveal(false);
  };

  const sendReveal = (missingVotesConfirmed: boolean): void => {
    if (phasePendingRef.current !== null) {
      return;
    }
    const latest = client.getSnapshot();
    const latestPolicy = phaseControlPolicy(latest);
    if (latestPolicy.disabled || latestPolicy.action !== "reveal") {
      setDialog(null);
      return;
    }
    const latestMissingCount = responseSummary(
      latest,
      voteCommandsRef.current,
    ).missingCount;
    if (!missingVotesConfirmed && latestMissingCount > 0) {
      setRevealMissingCount(latestMissingCount);
      setDialog("reveal");
      return;
    }
    setDialog(null);
    const result = autoReveal.requestManualReveal();
    if (result.status === "ignored") {
      setPending(null);
    } else if (result.status === "failed") {
      reportCommandError(result.error);
    }
  };

  const requestReset = (): void => {
    preventStaleDrawing();
    setDialog("reset");
  };

  const sendReset = (): void => {
    if (phasePendingRef.current !== null) {
      return;
    }
    const latest = client.getSnapshot();
    const latestPolicy = phaseControlPolicy(latest);
    if (latestPolicy.disabled || latestPolicy.action !== "reset") {
      setDialog(null);
      return;
    }
    setDialog(null);
    setPending("reset");
    try {
      client.startNewRound();
      setCommandError(null);
    } catch (error: unknown) {
      reportCommandError(error);
    }
  };

  const phaseAction = (): void => {
    if (phasePolicy.disabled || phasePendingRef.current !== null) {
      return;
    }
    if (phasePolicy.action === "reveal") {
      requestReveal();
    } else if (phasePolicy.action === "reset") {
      requestReset();
    }
  };

  const actionLabel =
    phasePolicy.action === "reset"
      ? "Reset"
      : autoRevealState.status === "counting" && countdownLabel !== null
        ? `Reveal in ${String(countdownLabel)}`
        : phasePolicy.action === "reveal"
          ? "Reveal"
          : "Unavailable";

  const morphStyle =
    morphGeometry === null
      ? undefined
      : ({
          "--vote-ink-origin-x": `${String(morphGeometry.originX)}%`,
          "--vote-ink-origin-y": `${String(morphGeometry.originY)}%`,
          "--vote-ink-translate-x": `${String(morphGeometry.translateX)}%`,
          "--vote-ink-translate-y": `${String(morphGeometry.translateY)}%`,
        } as CSSProperties);
  const connectionLabel = snapshot.status === "open" ? "live" : snapshot.status;
  const liveSummary = `${String(responseCount)} of ${String(voters.length)} responses. Connection ${connectionLabel}. Recognizer ${recognizerStatus.readiness}.`;
  const renderedVote =
    voteInput.status === "committing" && voteInput.value !== null
      ? String(voteInput.value)
      : displayVote;
  const hasRenderedVote =
    displayVote !== null || voteInput.status === "committing";
  const textualResult =
    renderedVote !== null && canonicalValue(renderedVote) === null;

  const room = snapshot.room;
  if (room === null) {
    return null;
  }

  return (
    <main className={`vote-route vote-shell vote-shell--${room.phase}`}>
      <header className="vote-header">
        <div className="vote-room-context">
          <span className="vote-monogram" aria-hidden="true">
            PP
          </span>
          <div>
            <p>
              Room {roomCode} / {room.name}
            </p>
            <h1>Cast your vote</h1>
          </div>
        </div>
        <div className="vote-phase-control">
          <button
            ref={phaseActionRef}
            className="vote-phase-button"
            disabled={phasePolicy.disabled || phasePending !== null}
            onClick={phaseAction}
            type="button"
          >
            {phasePending === phasePolicy.action
              ? `${actionLabel}...`
              : actionLabel}
          </button>
          <span className="vote-phase-secondary-slot">
            {autoRevealState.status === "counting" ? (
              <button
                className="vote-countdown-cancel"
                onClick={() => {
                  autoReveal.cancel();
                }}
                type="button"
              >
                Cancel
              </button>
            ) : null}
          </span>
        </div>
      </header>

      <section className="vote-workspace" aria-label="Vote input">
        <div
          className={`vote-draw-stage vote-draw-stage--${voteInput.status}`}
          data-effect-motion={voteInput.effectMotion ?? undefined}
          data-testid="drawing-stage"
          style={morphStyle}
        >
          <div className="vote-draw-heading">
            <div>
              <span className="vote-kicker">Handwriting input</span>
              <p id="ink-instructions">Write one deck number anywhere.</p>
            </div>
            <span
              className={`vote-recognizer vote-recognizer--${recognizerStatus.readiness}`}
            >
              {recognizerLabel(recognizerStatus)}
            </span>
          </div>
          <InkPad
            ref={inkRef}
            className={`vote-ink vote-ink--${voteInput.status}`}
            enabled={canDraw}
            onPointerAccepted={pointerAccepted}
            onStrokeCancel={() => {
              flow.strokeCancelled();
            }}
            onStrokeComplete={() => {
              flow.strokeCompleted();
            }}
          />
          {hasRenderedVote ? (
            <output
              className={`vote-result${voteInput.status === "committing" ? " vote-result--morphing" : ""}${textualResult ? " vote-result--textual" : ""}`}
              aria-label={`Current vote ${String(voteInput.value ?? displayVote ?? "")}`}
            >
              {renderedVote}
            </output>
          ) : null}
          {!hasRenderedVote &&
          !canDraw &&
          recognizerStatus.readiness !== "failed" ? (
            <p className="vote-draw-unavailable">
              {canVote
                ? "Recognizer loading. Deck buttons are ready."
                : room.phase === "revealed"
                  ? "Round revealed"
                  : "Drawing unavailable"}
            </p>
          ) : null}
          {recognizerStatus.readiness === "failed" ? (
            <div className="vote-recognizer-failure">
              <p>
                {recognizerStatus.error?.message ?? recognizerStatus.status}
              </p>
              <button
                onClick={() => {
                  try {
                    flow.retry();
                  } catch (error: unknown) {
                    reportCommandError(error);
                  }
                }}
                type="button"
              >
                Retry recognizer
              </button>
            </div>
          ) : null}
          <div
            className="vote-input-feedback"
            aria-atomic="true"
            aria-live="polite"
            role="status"
          >
            {inputFeedback(voteInput, diagnostics)}
            {voteInput.inferenceError !== null ? (
              <button
                onClick={() => {
                  try {
                    flow.retry();
                  } catch (error: unknown) {
                    reportCommandError(error);
                  }
                }}
                type="button"
              >
                Retry recognition
              </button>
            ) : null}
          </div>
        </div>

        <section className="vote-deck-panel" aria-labelledby="vote-deck-title">
          <div className="vote-deck-heading">
            <div>
              <span className="vote-kicker">Authoritative deck</span>
              <h2 id="vote-deck-title">Tap a card</h2>
            </div>
            {effectiveVote !== null ? (
              <button
                className="vote-clear-button"
                disabled={!canVote}
                onClick={clearVote}
                type="button"
              >
                Clear vote
              </button>
            ) : null}
          </div>
          <div className="vote-deck" role="group" aria-label="Voting cards">
            {room.deck.map((card, index) => {
              const selected = effectiveVote === card;
              const pending = currentVoteIntent?.value === card;
              return (
                <button
                  aria-label={`Vote ${card}`}
                  aria-pressed={selected}
                  className={`vote-card${voteCardSizeClass(card)}${selected ? " vote-card--selected" : ""}${pending ? " vote-card--pending" : ""}`}
                  disabled={!canVote}
                  key={`${card}:${String(index)}`}
                  onClick={() => {
                    voteForCard(card);
                  }}
                  type="button"
                >
                  {card}
                </button>
              );
            })}
          </div>
        </section>
      </section>

      <section
        className="vote-responses"
        aria-labelledby="vote-responses-title"
      >
        <div
          className="vote-response-summary"
          aria-label={`${String(responseCount)} of ${String(voters.length)} responses locked`}
          aria-valuemax={voters.length}
          aria-valuemin={0}
          aria-valuenow={responseCount}
          role="progressbar"
        >
          <span className="vote-kicker" id="vote-responses-title">
            Responses locked
          </span>
          <strong>
            {responseCount}/{voters.length}
          </strong>
        </div>
        <ol className="vote-slots">
          {voters.map((voter, index) => {
            const covered = isVoterCovered(
              voter,
              coverage.localVoter,
              currentVoteIntent,
            );
            return (
              <li
                className={
                  covered ? "vote-slot vote-slot--locked" : "vote-slot"
                }
                key={`${voter.name}:${String(index)}`}
              >
                <span aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <strong>{voter.name}</strong>
                <em>{covered ? "Voted" : "Thinking"}</em>
              </li>
            );
          })}
        </ol>
      </section>

      <footer className="vote-footer">
        <div className="vote-footer-statuses">
          <span>
            <i
              className={`vote-live-dot${snapshot.status === "open" ? "" : " vote-live-dot--offline"}`}
            />
            Connection {connectionLabel}
          </span>
          <span>Recognizer {recognizerStatus.readiness}</span>
          <a href="/legal/HANDWRITING_NOTICES.txt">Notices</a>
        </div>
        <div className="vote-name">
          <span>
            Voting as <strong>{currentName}</strong>
          </span>
          <button
            ref={renameButtonRef}
            onClick={() => {
              setDialog("rename");
            }}
            type="button"
          >
            Rename
          </button>
        </div>
      </footer>
      <p
        className="visually-hidden"
        aria-atomic="true"
        aria-live="polite"
        role="status"
      >
        {liveSummary}
      </p>

      {commandError !== null ? (
        <div className="vote-command-error" role="alert">
          <span>{commandError}</span>
          <button
            onClick={() => {
              setCommandError(null);
            }}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {dialog === "reveal" ? (
        <ConfirmDialog
          confirmLabel="Reveal anyway"
          description={`${String(revealMissingCount)} ${revealMissingCount === 1 ? "player has" : "players have"} not voted yet.`}
          onCancel={() => {
            setDialog(null);
          }}
          onConfirm={() => {
            sendReveal(true);
          }}
          returnFocusRef={phaseActionRef}
          title="Reveal with missing votes?"
        />
      ) : null}
      {dialog === "reset" ? (
        <ConfirmDialog
          confirmLabel="Start new round"
          description="The revealed result will be archived and every vote will be cleared."
          onCancel={() => {
            setDialog(null);
          }}
          onConfirm={sendReset}
          returnFocusRef={phaseActionRef}
          title="Reset this round?"
        />
      ) : null}
      {dialog === "rename" ? (
        <RenameDialog
          currentName={currentName}
          nameSession={nameSession}
          onCancel={() => {
            setDialog(null);
          }}
          onRenamed={(name) => {
            const latest = client.getSnapshot();
            const latestContextKey = votingContextKey(latest);
            if (latestContextKey !== null) {
              updateOptimisticName({
                contextKey: latestContextKey,
                revision: latest.revision,
                value: name,
              });
            }
            setDialog(null);
          }}
          client={client}
          returnFocusRef={renameButtonRef}
        />
      ) : null}
    </main>
  );
}

interface ConfirmDialogProps {
  readonly confirmLabel: string;
  readonly description: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly title: string;
}

function ConfirmDialog({
  confirmLabel,
  description,
  onCancel,
  onConfirm,
  returnFocusRef,
  title,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalDialog(dialogRef, cancelRef, returnFocusRef, onCancel);
  return (
    <dialog
      ref={dialogRef}
      aria-describedby="vote-dialog-description"
      aria-labelledby="vote-dialog-title"
      aria-modal="true"
      className="vote-dialog-modal"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <section className="vote-dialog">
        <span className="vote-kicker">Confirm phase action</span>
        <h2 id="vote-dialog-title">{title}</h2>
        <p id="vote-dialog-description">{description}</p>
        <div className="vote-dialog-actions">
          <button ref={cancelRef} onClick={onCancel} type="button">
            Cancel
          </button>
          <button onClick={onConfirm} type="button">
            {confirmLabel}
          </button>
        </div>
      </section>
    </dialog>
  );
}

interface RenameDialogProps {
  readonly client: PokerClient;
  readonly currentName: string;
  readonly nameSession: VoterNameSession;
  readonly onCancel: () => void;
  readonly onRenamed: (name: string) => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
}

function RenameDialog({
  client,
  currentName,
  nameSession,
  onCancel,
  onRenamed,
  returnFocusRef,
}: RenameDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentName);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  useModalDialog(dialogRef, inputRef, returnFocusRef, onCancel);
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): void => {
    event.preventDefault();
    try {
      const result = nameSession.rename(value, (name) => {
        client.rename(name);
      });
      if (!result.ok) {
        setValidationError(
          result.reason === "empty"
            ? "Enter a name."
            : "Names cannot contain control characters.",
        );
        return;
      }
      onRenamed(result.name);
    } catch (error: unknown) {
      setSubmissionError(errorMessage(error));
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="vote-rename-title"
      aria-modal="true"
      className="vote-dialog-modal"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <section className="vote-dialog">
        <span className="vote-kicker">Voter identity</span>
        <h2 id="vote-rename-title">Rename voter</h2>
        <form onSubmit={submit}>
          <label htmlFor="vote-name-input">Display name</label>
          <input
            ref={inputRef}
            aria-describedby={
              validationError !== null || submissionError !== null
                ? "vote-name-error"
                : undefined
            }
            id="vote-name-input"
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setValidationError(null);
              setSubmissionError(null);
            }}
            value={value}
          />
          {validationError === null && submissionError === null ? null : (
            <p id="vote-name-error" role="alert">
              {validationError ?? submissionError}
            </p>
          )}
          <div className="vote-dialog-actions">
            <button ref={cancelRef} onClick={onCancel} type="button">
              Cancel
            </button>
            <button type="submit">Save name</button>
          </div>
        </form>
      </section>
    </dialog>
  );
}

function useModalDialog(
  dialogRef: RefObject<HTMLDialogElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  returnFocusRef: RefObject<HTMLElement | null>,
  onCancel: () => void,
): void {
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const supportsModal = typeof dialog.showModal === "function";
    const inertedSiblings: { element: HTMLElement; inert: boolean }[] = [];
    if (supportsModal) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      dialog.setAttribute("open", "");
      for (const sibling of dialog.parentElement?.children ?? []) {
        if (sibling instanceof HTMLElement && sibling !== dialog) {
          inertedSiblings.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
    }
    initialFocusRef.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
      if (!supportsModal && event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? []),
        ];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (typeof dialog.close === "function" && dialog.open) {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
      for (const { element, inert } of inertedSiblings) {
        element.inert = inert;
      }
      returnFocusRef.current?.focus();
    };
  }, [dialogRef, initialFocusRef, returnFocusRef]);
}

export function numericDeck(deck: readonly string[]): readonly number[] {
  return deck.flatMap((card) => {
    const value = canonicalValue(card);
    return value === null ? [] : [value];
  });
}

export function voteCardSizeClass(card: string): string {
  if (card.length > 12) {
    return " vote-card--textual";
  }
  return card.length > 4 ? " vote-card--wide" : "";
}

function isVoterCovered(
  voter: Player,
  localVoter: Player | null,
  optimisticVote: PendingLocalVoteIntent | null,
): boolean {
  if (voter === localVoter && optimisticVote !== null) {
    return optimisticVote.value !== null;
  }
  return voter.vote.state !== "missing";
}

function responseSummary(
  snapshot: ClientSnapshot,
  voteCommands: LocalVoteCommandQueue | null,
): { readonly missingCount: number; readonly responseCount: number } {
  const coverage = votingCoverage(snapshot);
  const currentIntent = pendingLocalVoteIntent(voteCommands, snapshot);
  const responseCount = coverage.voters.filter((voter) =>
    isVoterCovered(voter, coverage.localVoter, currentIntent),
  ).length;
  return {
    missingCount: coverage.voters.length - responseCount,
    responseCount,
  };
}

function inkMorphGeometry(ink: InkPadHandle | null): InkMorphGeometry | null {
  if (ink === null) {
    return null;
  }
  const bounds = ink.getVisualBounds();
  const locus = ink.getCanonicalInkLocus();
  const source =
    bounds === null
      ? locus === null
        ? null
        : {
            x: locus.center.x,
            y: locus.center.y,
            width: locus.coordinateSpace.width,
            height: locus.coordinateSpace.height,
          }
      : {
          x: bounds.centerX,
          y: bounds.centerY,
          width: bounds.surfaceWidth,
          height: bounds.surfaceHeight,
        };
  if (source === null || source.width <= 0 || source.height <= 0) {
    return null;
  }
  const originX = (source.x / source.width) * 100;
  const originY = (source.y / source.height) * 100;
  return {
    originX,
    originY,
    translateX: 50 - originX,
    translateY: 50 - originY,
  };
}

function recognizerLabel(status: RecognizerStatus): string {
  if (status.readiness === "loading") {
    return `Recognizer ${String(Math.round(status.progress * 100))}%`;
  }
  return status.readiness === "ready"
    ? "Recognizer ready"
    : "Recognizer offline";
}

function inputFeedback(
  state: VoteInputState,
  diagnostics: FlowDiagnostics,
): string {
  if (state.inferenceError !== null) {
    return `Recognition failed: ${state.inferenceError}`;
  }
  if (state.status === "settling" || diagnostics.inferencePending) {
    return "Reading ink...";
  }
  if (state.status === "rejecting") {
    return rejectionMessage(state.rejection);
  }
  if (diagnostics.decision?.outcome === "reject") {
    return rejectionMessage(diagnostics.decision.rejection);
  }
  if (state.status === "committing") {
    return `Voting ${String(state.value)}.`;
  }
  return "";
}

function rejectionMessage(rejection: RejectionKind | null): string {
  if (rejection === "incomplete") {
    return "That number is incomplete for this deck. Try again or tap a card.";
  }
  if (rejection === "invalid") {
    return "That number is not in this deck. Try again or tap a card.";
  }
  return "The recognizer was not confident enough. Try again or tap a card.";
}

function defaultRecognitionRuntime(): RecognitionRuntime {
  return new RecognitionClient({
    preprocessingVersion: PREPROCESSING_CONFIG.version,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The command could not be sent.";
}
