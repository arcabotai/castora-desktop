export const DEFAULT_SETTINGS = {
  nodeBaseUrl: "https://haatz.quilibrium.com",
  hubSubmitUrl: "https://haatz.quilibrium.com/v1/submitMessage",
  selectedFid: null as number | null,
};

export type HypersnapUser = {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
  profile: { bio: { text: string } };
  follower_count: number;
  following_count: number;
};

export type HypersnapCast = {
  hash: string;
  text: string;
  timestamp: string;
  author: HypersnapUser;
  embeds: unknown[];
  reactions: { likes_count: number; recasts_count: number };
  replies: { count: number };
};

type FeedResponse = {
  casts?: HypersnapCast[];
  next?: { cursor?: string | null };
};

export function normalizeBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

export async function hypersnapGet<T>(
  nodeBaseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
) {
  const url = new URL(`${normalizeBaseUrl(nodeBaseUrl)}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);

  const response = await fetch(url, { signal: controller.signal }).finally(() => {
    window.clearTimeout(timeout);
  });

  if (!response.ok) {
    throw new Error(`Hypersnap request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchTrendingFeed(nodeBaseUrl: string) {
  const response = await hypersnapGet<FeedResponse>(nodeBaseUrl, "/v2/farcaster/feed", {
    fid: 3,
    limit: 20,
  });

  return response.casts ?? [];
}

export async function fetchFollowingFeed(nodeBaseUrl: string, fid: number) {
  const response = await hypersnapGet<FeedResponse>(
    nodeBaseUrl,
    "/v2/farcaster/feed/following",
    {
      fid,
      limit: 20,
    },
  );

  return response.casts ?? [];
}
