export const DEFAULT_SETTINGS = {
  nodeBaseUrl: "https://haatz.quilibrium.com",
  hubSubmitUrl: "https://haatz.quilibrium.com/v1/submitMessage",
  selectedFid: null as number | null,
};

export type HypersnapUser = {
  fid: number;
  username: string;
  display_name: string;
  custody_address?: string;
  pfp_url: string;
  profile: { bio: { text: string } };
  follower_count: number;
  following_count: number;
  verified_addresses?: {
    eth_addresses?: string[];
    sol_addresses?: string[];
    primary?: {
      eth_address?: string;
      sol_address?: string;
    };
  };
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

export type HypersnapSignerEvent = {
  fid: number;
  signer_key: string;
  key_type: number;
  metadata_type: number;
  block_number: number;
  block_timestamp: number;
};

export type HypersnapSigner = {
  fid?: number;
  key?: string;
  keyType?: number;
  source?: string;
  addedAt?: number;
  expiresAt?: number;
  ttl?: number;
};

type FeedResponse = {
  casts?: HypersnapCast[];
  next?: { cursor?: string | null };
};

type SignersResponse = {
  events?: HypersnapSignerEvent[];
  next?: { cursor?: string | null };
};

type SignersByFidResponse = {
  signers?: HypersnapSigner[];
  nextPageToken?: string;
  gaslessSignerCount?: number;
  gaslessSignerLimit?: number;
};

type UserResponse = {
  user?: HypersnapUser;
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

export async function fetchUserByFid(nodeBaseUrl: string, fid: number) {
  const response = await hypersnapGet<UserResponse>(nodeBaseUrl, "/v2/farcaster/user", {
    fid,
  });

  if (!response.user) {
    throw new Error(`No Farcaster user found for FID ${fid}.`);
  }

  return response.user;
}

export async function fetchUserByUsername(nodeBaseUrl: string, username: string) {
  const response = await hypersnapGet<UserResponse>(
    nodeBaseUrl,
    "/v2/farcaster/user/by-username",
    {
      username: normalizeUsername(username),
    },
  );

  if (!response.user) {
    throw new Error(`No Farcaster user found for ${username}.`);
  }

  return response.user;
}

export async function fetchUserByCustodyAddress(
  nodeBaseUrl: string,
  custodyAddress: string,
) {
  const response = await hypersnapGet<UserResponse>(
    nodeBaseUrl,
    "/v2/farcaster/user/custody-address",
    {
      custody_address: custodyAddress,
    },
  );

  if (!response.user) {
    throw new Error(`No Farcaster user found for custody address ${custodyAddress}.`);
  }

  return response.user;
}

export async function fetchSignerEvents(nodeBaseUrl: string, fid: number) {
  const response = await hypersnapGet<SignersResponse>(nodeBaseUrl, "/v2/farcaster/signer", {
    fid,
  });

  return response.events ?? [];
}

export async function fetchSignerKeys(nodeBaseUrl: string, fid: number) {
  const response = await hypersnapGet<SignersByFidResponse>(
    nodeBaseUrl,
    "/v1/signersByFid",
    { fid },
  );

  return (response.signers ?? [])
    .map((signer) => signer.key)
    .filter((key): key is string => typeof key === "string" && key.trim().length > 0);
}

export function isSignerRegistered(
  signerEvents: HypersnapSignerEvent[],
  publicKeyHex: string,
) {
  const expected = normalizeSignerKey(publicKeyHex);
  return signerEvents.some((event) => normalizeSignerKey(event.signer_key) === expected);
}

export function isSignerKeyRegistered(signerKeys: string[], publicKeyHex: string) {
  const expected = normalizeSignerKey(publicKeyHex);
  return signerKeys.some((key) => normalizeSignerKey(key) === expected);
}

export function normalizeSignerKey(key: string) {
  return key.trim().toLowerCase().replace(/^0x/, "");
}

export function normalizeUsername(username: string) {
  return username.trim().replace(/^@/, "");
}
