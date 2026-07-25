import { AnimatePresence, motion } from "motion/react";

import { motionTransition, useBroadcastLayout } from "../animation";
import type { DistributionVote } from "../scoreboard-model";
import { PresenceText } from "./ui/PresenceText";

interface VoteDistributionProps {
  readonly distribution: readonly DistributionVote[];
  readonly meta: string;
  readonly title: string;
  readonly titleId: string;
  readonly variant?: "compact" | "full";
}

export function compactLabel(label: string): string {
  if (label.length <= 4) {
    return label;
  }

  const normalized = label.trim();
  const trailingNumber = /(\d+)$/.exec(normalized)?.[1];
  if (trailingNumber !== undefined) {
    return `${normalized.charAt(0).toUpperCase()}${trailingNumber}`;
  }

  const words = normalized.split(/\s+/);
  if (words.length > 1) {
    return words
      .map((word) => word.charAt(0).toUpperCase())
      .join("")
      .slice(0, 4);
  }

  return `${normalized.slice(0, 2)}${normalized.charAt(normalized.length - 1)}`;
}

export function VoteDistribution({
  distribution,
  meta,
  title,
  titleId,
  variant = "full",
}: VoteDistributionProps) {
  const dense = distribution.length > 8;
  const highestCount = Math.max(1, ...distribution.map(({ count }) => count));
  const description = distribution
    .map(({ count, label }) => `${label} ${count.toString()}`)
    .join(", ");
  const layoutEnabled = useBroadcastLayout();

  return (
    <motion.figure
      aria-labelledby={titleId}
      className={`vote-distribution vote-distribution--${variant}${dense ? " vote-distribution--dense" : ""}`}
      data-density={dense ? "dense" : "standard"}
      layout={layoutEnabled}
      transition={{ layout: motionTransition.layout }}
    >
      <figcaption>
        <span id={titleId}>{title}</span>
        <AnimatePresence initial={false} mode="popLayout">
          <PresenceText as="small" className="type-meta" key={meta}>
            {meta}
          </PresenceText>
        </AnimatePresence>
      </figcaption>
      <motion.div
        aria-label={`${title}: ${description}`}
        className="distribution-chart"
        layout={layoutEnabled}
        role="img"
        transition={{ layout: motionTransition.layout }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {distribution.map((item) => {
            const scaleY = Math.max(0.03, item.count / highestCount);

            return (
              <motion.div
                className={`bar-slot${item.leader === true ? " bar-slot--leader" : ""}${item.special === true ? " bar-slot--special" : ""}`}
                data-motion-key={`distribution:${item.id}`}
                key={item.id}
                layout={layoutEnabled ? "position" : false}
                transition={{ layout: motionTransition.layout }}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <PresenceText
                    as="span"
                    className="bar-count"
                    hiddenFromAccessibility
                    key={item.count}
                  >
                    {item.count}
                  </PresenceText>
                </AnimatePresence>
                <motion.span
                  animate={{ scaleY }}
                  aria-hidden="true"
                  className="bar"
                  initial={false}
                  transition={motionTransition.layout}
                />
                <span
                  className="bar-label"
                  data-compact-label={
                    dense ? compactLabel(item.label) : undefined
                  }
                  title={item.label}
                >
                  {item.label}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </motion.figure>
  );
}
