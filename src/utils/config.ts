import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Single key for ALL services (including CabalSpy authentication)
  apiKey: process.env.CHAININSIGHT_API_KEY || '',

  questdb: {
    host: process.env.QUESTDB_HOST || 'localhost',
    fastPort: parseInt(process.env.QUESTDB_FAST_PORT || '9009'),
    pgPort: parseInt(process.env.QUESTDB_PG_PORT || '8812')
  },

  baseUrls: {
    // ChainInsight Endpoints
    walletTags: 'https://memeradar.chaininsight.vip/api/v1/wallet_tags',
    narration: 'https://ai_narration.chaininsight.vip/api/v1/narration',
    kolAnalysis: 'https://memeradar.chaininsight.vip/api/v1/kol_analysis_by_token',
    community: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_community_v2',
    callChannel: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_call_channel',

    // CabalSpy Base URL
    cabalSpy: process.env.CABALSPY_BASE_URL || 'https://api.cabalspy.xyz/v1',
  },

  // Add any other top-level configurations here if needed.
  DEFAULT_LANGUAGE: 'en',
  BASE_URL: 'https://api.chaininsight.vip/api/v1',
  ENDPOINTS: {
    COMMUNITY: '/narration',
    CALL_CHANNEL: '/narration',
    KOL_TRADES: '/narration',
    NARRATION: '/narration',
  },
};