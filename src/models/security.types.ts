export interface WalletTag {
    tagName: string;
    category: number;  // 99 for AI
    count?: number;
}

export interface ExpertTag {
    tagName: string;
    expertInfo: {
        kolId: number;
        name: string;
        avatar: string;
        twitter: string;
    };
}

export interface OfficialTag {
    link: string;
    tag: string;
}

export interface WalletInfo {
    address: string;
    count: number;
    tags: WalletTag[];
    expertTags?: ExpertTag[];
    officialTag?: OfficialTag;
}

export interface SecurityCheckResponse {
    chain: string;
    walletTags: WalletInfo[];
}