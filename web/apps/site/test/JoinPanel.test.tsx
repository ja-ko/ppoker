import { render } from "@testing-library/react";
import { encode } from "uqr";
import { describe, expect, it, vi } from "vitest";

import { JoinPanel } from "../src/components/JoinPanel";

vi.mock("uqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("uqr")>();
  return { ...actual, encode: vi.fn(actual.encode) };
});

describe("JoinPanel", () => {
  it("links a real, accessible QR code to the exact injected voting URL", () => {
    const voterUrl =
      "https://board.example/vote?room=Caf%C3%A9%20%E6%9D%B1%E4%BA%AC";
    const view = render(
      <JoinPanel
        roomCode="Café 東京"
        roomName="International planning"
        voterUrl={voterUrl}
      />,
    );

    expect(
      view
        .getByRole("link", { name: "Join International planning voting room" })
        .getAttribute("href"),
    ).toBe(voterUrl);
    expect(
      view.getByRole("img", {
        name: "QR code to join International planning",
      }),
    ).toBeDefined();
    expect(view.queryByText(/Preview|coming soon/)).toBeNull();
  });

  it("builds distinct matrices for different room codes, including Unicode", () => {
    const view = render(
      <JoinPanel
        baseUrl="https://board.example/display?mode=tv#score"
        roomCode="Room A"
        roomName="Planning"
      />,
    );
    const firstLink = view.getByRole("link", {
      name: "Join Planning voting room",
    });
    const firstMatrix = matrixSignature(view.container);

    expect(firstLink.getAttribute("href")).toBe(
      "https://board.example/vote?room=Room%20A",
    );

    view.rerender(
      <JoinPanel
        baseUrl="https://board.example/display?mode=tv#score"
        roomCode="部屋 B"
        roomName="Planning"
      />,
    );

    expect(
      view
        .getByRole("link", { name: "Join Planning voting room" })
        .getAttribute("href"),
    ).toBe("https://board.example/vote?room=%E9%83%A8%E5%B1%8B%20B");
    expect(matrixSignature(view.container)).not.toBe(firstMatrix);
  });

  it("encodes only when the resolved voter URL changes", () => {
    const encodeMock = vi.mocked(encode);
    const voterUrl = "https://board.example/vote?room=PX-082";
    const view = render(
      <JoinPanel
        roomCode="PX-082"
        roomName="Checkout Redesign"
        voterUrl={voterUrl}
      />,
    );

    expect(encodeMock).toHaveBeenCalledOnce();

    view.rerender(
      <JoinPanel
        roomCode="PX-082"
        roomName="Checkout Redesign"
        voterUrl={voterUrl}
      />,
    );
    expect(encodeMock).toHaveBeenCalledOnce();

    view.rerender(
      <JoinPanel
        roomCode="PX-082"
        roomName="Renamed room"
        voterUrl={voterUrl}
      />,
    );
    expect(encodeMock).toHaveBeenCalledOnce();
    expect(
      view.getByRole("img", { name: "QR code to join Renamed room" }),
    ).toBeDefined();

    view.rerender(
      <JoinPanel
        roomCode="PX-083"
        roomName="Renamed room"
        voterUrl="https://board.example/vote?room=PX-083"
      />,
    );
    expect(encodeMock).toHaveBeenCalledTimes(2);
  });

  it("renders a compact path with a crisp four-module quiet zone", () => {
    const view = render(
      <JoinPanel
        roomCode="PX-082"
        roomName="Checkout Redesign"
        voterUrl="https://board.example/vote?room=PX-082"
      />,
    );
    const qr = view.getByRole("img");
    const size = Number(qr.getAttribute("viewBox")?.split(" ").at(-1));
    const modulePaths =
      qr.querySelectorAll<SVGPathElement>("[data-qr-modules]");
    const coordinates = moduleCoordinates(modulePaths[0]?.getAttribute("d"));

    expect(qr.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(
      qr.querySelector("rect:not([data-qr-module])")?.getAttribute("fill"),
    ).toBe("#ffffff");
    expect(modulePaths).toHaveLength(1);
    expect(modulePaths[0]?.getAttribute("fill")).toBe("#000000");
    expect(Math.min(...coordinates)).toBe(4);
    expect(Math.max(...coordinates)).toBe(size - 5);
  });
});

function matrixSignature(container: HTMLElement): string {
  return (
    container
      .querySelector<SVGPathElement>("[data-qr-modules]")
      ?.getAttribute("d") ?? ""
  );
}

function moduleCoordinates(path: string | null | undefined): number[] {
  return [...(path ?? "").matchAll(/M(\d+) (\d+)h1v1h-1z/g)].flatMap(
    (match) => [Number(match[1]), Number(match[2])],
  );
}
