import { logger } from '../utils/logger';
import type { KolLeaderboardResponse } from '../models/kols.types';
import { config } from '../utils/config';

export class KolService {
    /**
     * Fetches the KOL leaderboards for a specific contract address directly
     * via the CabalSpy test-endpoint API.
     */
    async getLeaderboards(contractAddress: string, chain: 'Solana' | 'BSC' = 'Solana'): Promise<KolLeaderboardResponse> {
        const endpointUrl = `${config.baseUrls.cabalSpy}/api/Token/KOL_Leaderboard_bnb?mint=${contractAddress}&api_key=${config.cabalSpyApiKey}`;

        const res = await fetch("https://apidashboard.cabalspy.xyz/test-endpoint", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                endpoint_url: endpointUrl,
                api_key: config.cabalSpyApiKey,
            }),
        });

        const data = await res.json() as KolLeaderboardResponse;
        logger.info(`Fetched KOL leaderboard for ${contractAddress} (${chain})`);
        return data;
    }

    /**
     * Disabled since QuestDB dependency is removed.
     */
    async getGlobalLeaderboards(chain: string, limit: number = 50): Promise<KolLeaderboardResponse[]> {
        throw new Error("getGlobalLeaderboards is disabled (QuestDB removed).");
    }
}
