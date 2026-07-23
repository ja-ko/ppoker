import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  gotoFixture,
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
    await expect(page.getByRole("region", { name: "Round 08" })).toBeVisible();
    await expect(page.getByText("Observed just now").first()).toBeVisible();
    await expect(page.getByText(/Completed /)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(
      "Round 9. Voting open. 6 of 10 responses locked.",
    );
    await expectMotionSettled(page, "playing");
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
    await gotoFixture(page, "terminal-error");

    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.getByText(/E2E fixture transport ended/)).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expectNoCommands(page);
  });
});
