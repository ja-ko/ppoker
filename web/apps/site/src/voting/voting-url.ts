export type VotingUrlBase = string | URL | Pick<Location, "href">;

export function buildVotingUrl(
  roomCode: string,
  baseUrl: VotingUrlBase,
): string {
  const url = new URL(typeof baseUrl === "string" ? baseUrl : baseUrl.href);

  url.pathname = "/vote";
  url.search = `?room=${encodeURIComponent(roomCode)}`;
  url.hash = "";

  return url.href;
}
