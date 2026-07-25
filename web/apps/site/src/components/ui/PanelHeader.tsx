import type { ReactNode } from "react";

import { SectionLabel } from "./SectionLabel";

interface PanelHeaderProps {
  readonly children: string;
  readonly trailing?: ReactNode;
}

export function PanelHeader({ children, trailing }: PanelHeaderProps) {
  return (
    <div className="panel-header">
      <SectionLabel>{children}</SectionLabel>
      {trailing === undefined ? null : (
        <div className="panel-header-trailing">{trailing}</div>
      )}
    </div>
  );
}
