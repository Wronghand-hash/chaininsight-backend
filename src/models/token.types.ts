export interface Narrative {
  narrative: string;
}

export interface CommunityAttention {
  communityCount: number;
  mentionCount: number;
  communityAttentions: Array<{
    communityName: string;
    mentionCount: number;
    link?: string;
  }>;
}

export interface CallChannel {
  channelName: string;
  link: string;
  marketCap?: number;
  timestamp: number;
}

export interface TokenInfoResponse {
  narrative: Narrative;
  community: { communityAttentionInfo: CommunityAttention };
  calls: { callChannels: CallChannel[] };
}

export interface PriceResponse {
  priceUsd: string;
  priceChange: number;
  volume: number;
  timestamp: number;
}

export interface HistoricalPrice extends Omit<PriceResponse, 'priceChange'> {
  // priceChange omitted; compute separately
}