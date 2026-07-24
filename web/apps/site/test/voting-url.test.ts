import { describe, expect, it } from "vitest";

import { buildVotingUrl } from "../src/voting/voting-url";

describe("buildVotingUrl", () => {
  it("builds the voting route at the origin root", () => {
    expect(
      buildVotingUrl(
        "PX-082",
        new URL("https://board.example/hosted/broadcast?mode=tv#score"),
      ),
    ).toBe("https://board.example/vote?room=PX-082");
  });

  it("accepts a location-like value and replaces search and fragments", () => {
    expect(
      buildVotingUrl("next&room=value#fragment", {
        href: "https://board.example/?existing=value#broadcast",
      }),
    ).toBe("https://board.example/vote?room=next%26room%3Dvalue%23fragment");
  });

  it("encodes Unicode room codes into distinct URLs", () => {
    const baseUrl = "https://board.example/current";

    expect(buildVotingUrl("Café 東京", baseUrl)).toBe(
      "https://board.example/vote?room=Caf%C3%A9%20%E6%9D%B1%E4%BA%AC",
    );
    expect(buildVotingUrl("Café 大阪", baseUrl)).not.toBe(
      buildVotingUrl("Café 東京", baseUrl),
    );
  });
});
