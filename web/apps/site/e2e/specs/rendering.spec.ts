import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  expectPanelHeadersInFlow,
  gotoFixture,
  publishFixture,
} from "./helpers";

test.describe("scoreboard harness rendering", () => {
  test("renders an initial playing snapshot", async ({ page }) => {
    await gotoFixture(page, "playing");

    await expect(
      page.getByRole("heading", { name: "Cards in play" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Planning Poker Room" }),
    ).toBeVisible();
    await expect(page.locator(".eyebrow")).toContainText(
      "Authoritative E2E Room / E2E-ROOM",
    );
    const roomAccess = page.getByRole("region", {
      name: "Room access preview",
    });
    await expect(roomAccess.getByText("Preview")).toBeVisible();
    await expect(roomAccess.getByText("Authoritative E2E Room")).toBeVisible();
    await expect(roomAccess.getByText(/Join code coming soon/)).toBeVisible();
    await expect(roomAccess.getByRole("img")).toHaveCount(0);
    await expect(roomAccess.locator(".qr-code")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "6",
    );
    await expect(page.locator('[data-participant-id^="player:"]')).toHaveCount(
      10,
    );
    const participantGeometry = await page
      .locator(".participant-grid")
      .evaluate((grid) => {
        const style = getComputedStyle(grid);
        return {
          childCount: grid.children.length,
          columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
          rows: style.gridTemplateRows.split(" ").filter(Boolean).length,
        };
      });
    expect(participantGeometry).toEqual({
      childCount: 10,
      columns: 5,
      rows: 2,
    });
    await expect
      .poll(() =>
        page
          .locator(".participant-card--thinking")
          .first()
          .evaluate((card) => getComputedStyle(card, "::before").animationName),
      )
      .not.toBe("none");
    await expect(page.getByRole("region", { name: "Round 08" })).toBeVisible();
    await expect(page.getByText("Observed just now").first()).toBeVisible();
    await expect(page.getByText(/Completed /)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(
      "Round 9. Voting open. 6 of 10 responses locked.",
    );
    await expectMotionSettled(page, "playing");
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("renders an initial revealed snapshot", async ({ page }) => {
    await gotoFixture(page, "revealed");

    await expect(
      page.getByRole("heading", { name: "Participant cards" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Vote distribution" }),
    ).toBeVisible();
    await expect(page.locator(".average-value")).toHaveText("5.3");
    await expect(
      page.locator('[data-participant-id="player:Ada:1"]'),
    ).toHaveAttribute("aria-label", "Ada: 5");
    await expectMotionSettled(page, "revealed");
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("sorts revealed cards by vote while retaining duplicate identities", async ({
    page,
  }) => {
    await gotoFixture(page, "sorted-revealed");
    await expectMotionSettled(page, "revealed");

    const cards = page.locator(".participant-grid > .participant-card");
    await expect(cards).toHaveCount(10);
    expect(
      await cards.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-participant-id")),
      ),
    ).toEqual([
      "player:Ada:1",
      "player:Zoe:1",
      "player:Five:1",
      "player:Same:1",
      "player:Same:2",
      "player:Break:1",
      "player:Question:1",
      "player:Unknown%20alpha:1",
      "player:Unknown%20zebra:1",
      "player:Missing:1",
    ]);
    await expect(cards).toContainText([
      "3Ada",
      "3Zoe",
      "5Five",
      "8Same",
      "8Same",
      "BreakBreak",
      "?Question",
      "AlphaUnknown alpha",
      "ZebraUnknown zebra",
      "-Missing",
    ]);
    await expectNoCommands(page);
  });

  test("omits the previous-result slot on the first round", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1024 });
    await gotoFixture(page, "first-playing");

    await expect(page.locator(".phase-panel")).toHaveCount(0);
    await expect(page.getByText("Awaiting first result")).toHaveCount(0);
    const emptyTrackGeometry = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>(".primary-column");
      const panel = document.querySelector<HTMLElement>(
        '[data-motion-key="broadcast:participant-panel"]',
      );
      if (column === null || panel === null) {
        throw new Error("First-round primary geometry is missing.");
      }
      const columnBox = column.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return {
        columnBottom: columnBox.bottom,
        emptyHeight: columnBox.bottom - panelBox.bottom,
        panelBottom: panelBox.bottom,
      };
    });
    expect(emptyTrackGeometry.panelBottom).toBeLessThan(
      emptyTrackGeometry.columnBottom,
    );
    expect(emptyTrackGeometry.emptyHeight).toBeGreaterThan(100);
    await expect(page.getByText("No completed rounds yet.")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Round history" }),
    ).toBeVisible();
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("renders overflow totals and the participant summary", async ({
    page,
  }) => {
    await gotoFixture(page, "overflow");

    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "18",
    );
    await expect(
      page.getByRole("listitem", { name: "7 more participants" }),
    ).toBeVisible();
    await expect(page.locator(".participant-card")).toHaveCount(12);
    await expectNoCommands(page);
  });

  test("renders a terminal fake-client error state", async ({ page }) => {
    await gotoFixture(page, "playing");
    await publishFixture(page, "terminal-error");

    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.getByText(/E2E fixture transport ended/)).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);
    await expectPanelHeadersInFlow(page);

    await publishFixture(page, "closed");
    await expect(
      page.getByRole("heading", { name: "Connection closed" }),
    ).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);

    await gotoFixture(page, "terminal-error");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);
    await expectNoCommands(page);
  });
});
