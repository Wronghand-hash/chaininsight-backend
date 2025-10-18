import dotenv from 'dotenv';
dotenv.config();

// Reinstated QuestDB config and kept the single API key
export const config = {
  // Single key for ALL services (including CabalSpy authentication)
  apiKey: process.env.CHAININSIGHT_API_KEY || '',

  questdb: {
    host: process.env.QUESTDB_HOST || 'localhost',
    fastPort: parseInt(process.env.QUESTDB_FAST_PORT || '9009'),
    pgPort: parseInt(process.env.QUESTDB_PG_PORT || '8812')
  },

  baseUrls: {
    walletTags: 'https://memeradar.chaininsight.vip/api/v1/wallet_tags',
    narration: 'https://ai_narration.chaininsight.vip/api/v1/narration',
    kolAnalysis: 'https://memeradar.chaininsight.vip/api/v1/kol_analysis_by_token',
    community: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_community_v2',
    callChannel: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_call_channel',

    // ADDED: The assumed CabalSpy base URL
    cabalSpy: process.env.CABALSPY_BASE_URL || 'https://api.cabalspy.xyz/v1',

    // REMOVED: The 'dexscreener' URL as requested.
  }
};