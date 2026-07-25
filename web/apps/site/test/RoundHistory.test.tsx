import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoundHistory } from "../src/components/RoundHistory";
import type { HistoryEntry } from "../src/scoreboard-model";

describe("RoundHistory motion ordering", () => {
  it("prepends a keyed row without remounting the existing history rows", () => {
    const first = historyEntry("round-1", 1);
    const second = historyEntry("round-2", 2);
    const newest = historyEntry("round-3", 3);
    const view = render(<RoundHistory history={[second, first]} />);
    const initialRows = within(view.getByRole("list")).getAllByRole("listitem");

    view.rerender(<RoundHistory history={[newest, second, first]} />);

    const rows = within(view.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset["motionKey"])).toEqual([
      "broadcast:history:round-3",
      "broadcast:history:round-2",
      "broadcast:history:round-1",
    ]);
    expect(rows[1]).toBe(initialRows[0]);
    expect(rows[2]).toBe(initialRows[1]);
  });

  it("keeps five accessible rows while the displaced fifth row exits", () => {
    const initialHistory = [5, 4, 3, 2, 1].map((round) =>
      historyEntry(`round-${round.toString()}`, round),
    );
    const updatedHistory = [6, 5, 4, 3, 2].map((round) =>
      historyEntry(`round-${round.toString()}`, round),
    );
    const view = render(<RoundHistory history={initialHistory} />);
    const initialRows = within(view.getByRole("list")).getAllByRole("listitem");

    view.rerender(<RoundHistory history={updatedHistory} />);

    const list = view.getByRole("list");
    const accessibleRows = within(list).getAllByRole("listitem");
    const allRows = list.querySelectorAll<HTMLElement>(":scope > li");
    expect(accessibleRows.map((row) => row.dataset["motionKey"])).toEqual([
      "broadcast:history:round-6",
      "broadcast:history:round-5",
      "broadcast:history:round-4",
      "broadcast:history:round-3",
      "broadcast:history:round-2",
    ]);
    expect(allRows).toHaveLength(6);
    expect(
      list.querySelector<HTMLElement>(
        '[data-motion-key="broadcast:history:round-1"]',
      )?.ariaHidden,
    ).toBe("true");
    expect(accessibleRows[1]).toBe(initialRows[0]);
    expect(accessibleRows[4]).toBe(initialRows[3]);
  });
});

function historyEntry(id: string, round: number): HistoryEntry {
  return { age: "just now", average: "5.0", id, round };
}
