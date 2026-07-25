import { motion, useIsPresent } from "motion/react";
import { forwardRef, type ReactNode } from "react";

import { contentSwapMotion, useBroadcastPresence } from "../../animation";

type PresenceTextElement = "dd" | "small" | "span" | "strong";

interface PresenceTextProps {
  readonly as: PresenceTextElement;
  readonly children: ReactNode;
  readonly className?: string;
  readonly hiddenFromAccessibility?: boolean;
}

export const PresenceText = forwardRef<HTMLElement, PresenceTextProps>(
  function PresenceText(
    { as, children, className, hiddenFromAccessibility = false },
    ref,
  ) {
    const isPresent = useIsPresent();
    const valueMotion = useBroadcastPresence(contentSwapMotion);
    const ariaHidden = hiddenFromAccessibility || !isPresent ? true : undefined;
    const motionProps = {
      ...valueMotion,
      "aria-hidden": ariaHidden,
      className,
    };

    switch (as) {
      case "dd":
        return (
          <motion.dd {...motionProps} ref={ref}>
            {children}
          </motion.dd>
        );
      case "small":
        return (
          <motion.small {...motionProps} ref={ref}>
            {children}
          </motion.small>
        );
      case "strong":
        return (
          <motion.strong {...motionProps} ref={ref}>
            {children}
          </motion.strong>
        );
      case "span":
        return (
          <motion.span {...motionProps} ref={ref}>
            {children}
          </motion.span>
        );
    }
  },
);
