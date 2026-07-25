import { MotionConfig, type Transition, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export const REDUCED_MOTION_PREFERENCE = "user" as const;
export const PARTICIPANT_PANEL_LAYOUT_ID = "broadcast:participant-panel";

export const JOIN_ROUTE_EXIT_DURATION_SECONDS = 0.18;
export const SCOREBOARD_REVEAL_DELAY_MS = 700;

export const scoreboardEntranceTiming = {
  bodyDelay: 0.78,
  bodyDuration: 0.22,
  brandDelay: 0.18,
  brandDuration: 0.18,
  headerItemDelay: 0.36,
  headerItemDuration: 0.22,
  headerItemStagger: 0.05,
  lineDuration: 0.18,
} as const;

export const joinRouteExitTransition = {
  duration: JOIN_ROUTE_EXIT_DURATION_SECONDS,
  ease: [0.4, 0, 1, 1],
} as const satisfies Transition;

export const motionTransition = {
  layout: {
    damping: 38,
    mass: 0.82,
    stiffness: 390,
    type: "spring",
  },
  finalEnter: {
    delay: 0.28,
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  panelEnter: {
    delay: 0.1,
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  panelExit: {
    duration: 0.2,
    ease: [0.4, 0, 1, 1],
  },
  support: {
    duration: 0.2,
    ease: [0.22, 1, 0.36, 1],
  },
} as const satisfies Record<string, Transition>;

export const phasePanelMotion = {
  final: {
    animate: {
      opacity: 1,
      scale: 1,
      x: 0,
      y: 0,
      transition: motionTransition.finalEnter,
    },
    exit: {
      opacity: 0,
      scale: 0.985,
      y: -14,
      transition: motionTransition.panelExit,
    },
    initial: { opacity: 0, scale: 0.985, y: -22 },
  },
  previous: {
    animate: {
      opacity: 1,
      scale: 1,
      x: 0,
      y: 0,
      transition: motionTransition.panelEnter,
    },
    exit: {
      opacity: 0,
      scale: 0.985,
      y: -14,
      transition: motionTransition.panelExit,
    },
    initial: { opacity: 0, scale: 0.985, y: 14 },
  },
} as const;

export const contentSwapMotion = {
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: motionTransition.support,
  },
  exit: {
    opacity: 0,
    scale: 0.985,
    y: 6,
    transition: motionTransition.support,
  },
  initial: { opacity: 0, scale: 0.985, y: -6 },
} as const;

export const historyItemMotion = {
  animate: {
    opacity: 1,
    y: 0,
    transition: motionTransition.layout,
  },
  exit: {
    opacity: 0,
    y: 10,
    transition: motionTransition.panelExit,
  },
  initial: { opacity: 0, y: -18 },
} as const;

const reducedPresenceMotion = {
  animate: { opacity: 1, transition: { duration: 0 } },
  exit: { opacity: 1, transition: { duration: 0 } },
  initial: false,
} as const;

export function useBroadcastPresence<PresenceMotion>(
  presenceMotion: PresenceMotion,
): PresenceMotion | typeof reducedPresenceMotion {
  return useReducedMotion() === true ? reducedPresenceMotion : presenceMotion;
}

export function useBroadcastLayout(): boolean {
  return useReducedMotion() !== true;
}

export function participantCardLayoutId(participantId: string): string {
  return `broadcast:participant:${participantId}`;
}

export function historyMotionKey(historyId: string): string {
  return `broadcast:history:${historyId}`;
}

export function BroadcastMotionConfig({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <MotionConfig reducedMotion={REDUCED_MOTION_PREFERENCE}>
      {children}
    </MotionConfig>
  );
}
