import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Panel } from "../src/components/ui/Panel";

describe("Panel", () => {
  it.each([
    ["ice", "full-width"],
    ["ice", "top-right"],
    ["vermilion", "full-width"],
    ["vermilion", "top-right"],
  ] as const)("renders the %s %s accent", (accent, accentPlacement) => {
    const view = render(
      <Panel accent={accent} accentPlacement={accentPlacement}>
        Scoreboard panel
      </Panel>,
    );
    const panel = view.getByText("Scoreboard panel");

    expect(panel.tagName).toBe("SECTION");
    expect(panel.dataset["accent"]).toBe(accent);
    expect(panel.dataset["accentPlacement"]).toBe(accentPlacement);
  });

  it("renders an unaccented surface", () => {
    const view = render(<Panel>Plain panel</Panel>);
    const panel = view.getByText("Plain panel");

    expect(panel.dataset["accent"]).toBeUndefined();
    expect(panel.dataset["accentPlacement"]).toBeUndefined();
  });
});
