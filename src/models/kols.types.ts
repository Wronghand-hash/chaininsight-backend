export interface KolTradeStat {
    kolName: string;
    action: 'buy' | 'sell' | 'add' | 'partial_sell' | 'full_sell';
    amount: number;
}

export interface KolLeaderboardResponse {
    buyerCount: number;
    sellerCount: number;
    clearCount?: number;
    tradeStatList: KolTradeStat[];
}