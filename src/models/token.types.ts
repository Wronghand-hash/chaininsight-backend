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

export interface PriceResponse {
  priceUsd: string;
  volume: number;
  marketCap: number;
}

export type TokenInfoResponse = {
  narrative: any;
  community: any;
  calls: any;
  pairs?: any[];
  honeypot?: any;
  goplusSecurity?: any;
};