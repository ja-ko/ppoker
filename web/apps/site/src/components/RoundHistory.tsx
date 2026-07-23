import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { forwardRef } from "react";

import {
  historyItemMotion,
  historyMotionKey,
  motionTransition,
  useBroadcastLayout,
  useBroadcastPresence,
} from "../animation";
import type { HistoryEntry } from "../scoreboard-model";
import { Panel } from "./ui/Panel";
import { SectionLabel } from "./ui/SectionLabel";

interface RoundHistoryProps {
  readonly history: readonly HistoryEntry[];
}

export const RECENT_HISTORY_LIMIT = 5;

interface HistoryRowProps {
  readonly index: number;
  readonly item: HistoryEntry;
  readonly layoutEnabled: boolean;
}

const HistoryRow = forwardRef<HTMLLIElement, HistoryRowProps>(
  function HistoryRow({ index, item, layoutEnabled }, ref) {
    const itemMotion = useBroadcastPresence(historyItemMotion);
    const isPresent = useIsPresent();
    const motionKey = historyMotionKey(item.id);

    return (
      <motion.li
        {...itemMotion}
        aria-hidden={isPresent ? undefined : true}
        data-motion-key={motionKey}
        layout={layoutEnabled ? "position" : false}
        ref={ref}
        transition={{ layout: motionTransition.layout }}
      >
        <span aria-hidden="true" className="history-rank">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div>
          <strong>Round {item.round}</strong>
          <time aria-label={`Observed ${item.age}`} className="type-supporting">
            Observed {item.age}
          </time>
        </div>
        <p>
          <small className="type-meta">Avg</small>
          {item.average}
        </p>
      </motion.li>
    );
  },
);

export function RoundHistory({ history }: RoundHistoryProps) {
  // The view model is newest-first; the billboard reserves space for five rounds.
  const recentHistory = history.slice(0, RECENT_HISTORY_LIMIT);
  const layoutEnabled = useBroadcastLayout();

  return (
    <Panel
      accent="ice"
      accentPlacement="top-right"
      aria-labelledby="history-title"
      className="history-panel"
      layout={layoutEnabled}
      transition={{ layout: motionTransition.layout }}
    >
      <div className="history-heading">
        <SectionLabel>Match log</SectionLabel>
        <h2 id="history-title">Round history</h2>
      </div>
      {recentHistory.length === 0 ? (
        <p className="history-empty type-supporting">
          No completed rounds yet.
        </p>
      ) : (
        <motion.ol
          aria-label="Most recent completed rounds"
          className="history-list"
          layout={layoutEnabled}
          transition={{ layout: motionTransition.layout }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {recentHistory.map((item, index) => (
              <HistoryRow
                index={index}
                item={item}
                key={item.id}
                layoutEnabled={layoutEnabled}
              />
            ))}
          </AnimatePresence>
        </motion.ol>
      )}
    </Panel>
  );
}
