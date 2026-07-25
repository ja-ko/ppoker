export type VotingUrlBase = string | URL | Pick<Location, "href">;

export function buildVotingUrl(
  roomCode: string,
  baseUrl: VotingUrlBase,
): string {
  const url = new URL(typeof baseUrl === "string" ? baseUrl : baseUrl.href);
  const search = `?room=${encodeURIComponent(roomCode)}`;

  if (url.hash.startsWith("#/")) {
    url.search = "";
    url.hash = `#/vote${search}`;
  } else {
    url.pathname = "/vote";
    url.search = search;
    url.hash = "";
  }

  return url.href;
}
