import { MotionConfigContext } from "motion/react";
import { useContext } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BroadcastMotionConfig,
  historyMotionKey,
  participantCardLayoutId,
} from "../src/animation";

describe("broadcast motion configuration", () => {
  it("honors the user's reduced-motion preference globally", () => {
    function ReducedMotionProbe() {
      const config = useContext(MotionConfigContext);
      return <output>{config.reducedMotion}</output>;
    }

    const view = render(
      <BroadcastMotionConfig>
        <ReducedMotionProbe />
      </BroadcastMotionConfig>,
    );

    expect(view.getByText("user")).toBeDefined();
  });

  it("namespaces stable participant and history motion keys", () => {
    expect(participantCardLayoutId("player:Ada:1")).toBe(
      "broadcast:participant:player:Ada:1",
    );
    expect(historyMotionKey("round:2:source:3")).toBe(
      "broadcast:history:round:2:source:3",
    );
  });
});
