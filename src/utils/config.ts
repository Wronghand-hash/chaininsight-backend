import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Single key for ALL services (including CabalSpy authentication)
  apiKey: process.env.CHAININSIGHT_API_KEY || '',

  questdb: {
    host: process.env.QUESTDB_HOST || 'localhost',
    fastPort: parseInt(process.env.QUESTDB_FAST_PORT || '9009'),
    pgPort: parseInt(process.env.QUESTDB_PG_PORT || '8812'),
    useIlpForWrites: (process.env.QUESTDB_USE_ILP_WRITES || 'false').toLowerCase() === 'true',
    enableWal: (process.env.QUESTDB_ENABLE_WAL || 'false').toLowerCase() === 'true',
    diagnosticsVerbose: (process.env.QUESTDB_DIAGNOSTICS_VERBOSE || 'false').toLowerCase() === 'true',
    ilpFlushRows: parseInt(process.env.QUESTDB_ILP_FLUSH_ROWS || '1000'),
    ilpFlushMs: parseInt(process.env.QUESTDB_ILP_FLUSH_MS || '250')
  },

  baseUrls: {
    // ChainInsight Endpoints
    walletTags: 'https://memeradar.chaininsight.vip/api/v1/wallet_tags',
    narration: 'https://ai_narration.chaininsight.vip/api/v1/narration',
    kolAnalysis: 'https://memeradar.chaininsight.vip/api/v1/kol_analysis_by_token',
    community: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_community_v2',
    callChannel: 'https://memeradar.chaininsight.vip/api/v1/analyze_token_call_channel',
    dexscreener: 'https://api.dexscreener.com/latest/dex/tokens/',

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