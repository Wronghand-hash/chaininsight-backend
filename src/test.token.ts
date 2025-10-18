// test-token.ts
// Standalone test: Run with npx ts-node src/test-token.ts (from project root)
// Tests TokenService.getLeaderboards for a single BSC token (e.g., USDT)
// Preserves: QuestDB running (docker) and API key in .env (loads from root)

import path from 'path';
import dotenv from 'dotenv';

// Load .env from project root (absolute path for standalone)
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

// Local imports (relative to src/)
import { questdbService } from './services/questDbService';
import { KolService } from './services/kolsLeaderboard';
import { TokenService } from './services/tokenService';
// Removed: import { SecurityService } from './services/securityService';
// Removed: import { PriceService } from './services/tokenPriceService';

async function testTokenInfo() {
    const kolService = new KolService();
    const contractAddress = '0x0A43fC31a73013089DF59194872Ecae4cAe14444'; // USDT on BSC
    const chain = 'BSC';

    console.log(`\n--- Testing Token Leaderboard for ${chain} token: ${contractAddress} ---\n`);

    try {

        //tokenServiceTest
        await questdbService.init();
        const tokenService = new TokenService();
        const tokenInfo = await tokenService.getTokenInfo(contractAddress, chain);
        console.log('✅ Token Info Test Successful');
        console.log('Token Info:', JSON.stringify(tokenInfo, null, 2));

        // console.log('✅ Token Leaderboard Test Successful');
        // console.log('Leaderboard Result:', JSON.stringify(leaderboard, null, 2));

    } catch (error: any) {
        console.error('❌ Test failed:', error);
        if (error.message.includes('ECONNREFUSED')) {
            console.log('\n💡 Tip: Ensure QuestDB Docker is running (docker ps | grep questdb).');
        } else if (error.message.includes('ChainInsight API') || error.status === 401) {
            console.log('\n💡 Tip: Check API key in .env or trial limits (status 401 = missing/invalid key).');
        } else if (error.message.includes('dateadd')) {
            console.log('\n💡 Tip: Update SQL syntax in services (use \'h\' for hour, \'m\' for minute).');
        } else {
            console.log('\n💡 Tip: Check if the getTokenLeaderboards method exists and its implementation is correct.');
        }
    } finally {
        await questdbService.close();  // Clean shutdown
        console.log('\n--- QuestDB connection closed. ---');
    }
}

testTokenInfo();