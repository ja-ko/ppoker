import { motion, type HTMLMotionProps, useIsPresent } from "motion/react";
import { forwardRef, type ReactNode } from "react";

export type PanelAccent = "ice" | "vermilion";
export type PanelAccentPlacement = "full-width" | "top-right";

type AccentProps =
  | {
      readonly accent?: never;
      readonly accentPlacement?: never;
    }
  | {
      readonly accent: PanelAccent;
      readonly accentPlacement: PanelAccentPlacement;
    };

export type PanelProps = Omit<HTMLMotionProps<"section">, "children"> &
  AccentProps & {
    readonly children: ReactNode;
  };

export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  {
    accent,
    accentPlacement,
    "aria-hidden": ariaHidden,
    children,
    className,
    ...sectionProps
  },
  ref,
) {
  const isPresent = useIsPresent();

  return (
    <motion.section
      aria-hidden={ariaHidden ?? (isPresent ? undefined : true)}
      className={["panel", className].filter(Boolean).join(" ")}
      data-accent={accent}
      data-accent-placement={accentPlacement}
      ref={ref}
      {...sectionProps}
    >
      {children}
    </motion.section>
  );
});
