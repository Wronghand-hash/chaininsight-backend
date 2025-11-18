import dotenv from 'dotenv';
dotenv.config();

export const config = {

  // Single key for ALL services (including CabalSpy authentication)
  apiKey: process.env.CHAININSIGHT_API_KEY || '',
  cabalSpyApiKey: process.env.CABALSPY_API_KEY || '',

  twitter: {
    clientId: process.env.TWITTER_CLIENT_ID || 'VzM5YWNJdnZpOFRGWUhaaEFxVVo6MTpjaQ',
    appKey: process.env.TWITTER_APP_KEY || '3TiDnGDy17vgyHwq7pen11cHd',
    appSecret: process.env.TWITTER_APP_SECRET || 'Yu6zwoztmMdwgnsdon5oHzWfdkvPCjUQx1iPMaYky6L8bsdOw4',
    accessToken: process.env.TWITTER_ACCESS_TOKEN || '1769379822684229632-Wna0KjPL0b9puuzucpUYSqewULjPp5',
    accessSecret: process.env.TWITTER_ACCESS_SECRET || '8bSXJ0sc0UsG1TBZpdRSvWrb1Huqet9o0p8yfKUAdvlNx',
    clientSecret: process.env.TWITTER_CLIENT_SECRET || '4S0q6Ht2-tPXitqHQmxEKiPKJEKVE203UzPaeEFOL16F8hNZhq',
  },

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

  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  BSC_RPC_URL: process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
};