// test-token.ts
// Standalone test: Run with npx ts-node src/test-token.ts (from project root)
// Tests TokenService.getTokenInfo for a single BSC token (e.g., USDT)
// Preserves: QuestDB running (docker) and API key in .env (loads from root)

import path from 'path';
import dotenv from 'dotenv';

// Load .env from project root (absolute path for standalone)
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

// Local imports (relative to src/)
import { questdbService } from './services/questDbService';
import { TokenService } from './services/tokenService';

async function testTokenInfo() {
    const tokenService = new TokenService();
    const contractAddress = '0x55d398326f99059fF775485246999027B3197955'; // USDT on BSC
    const chain = 'BSC';

    try {
        console.log(`Initializing QuestDB...`);
        await questdbService.init();  // Await DB init (connects Sender + PG)
        console.log('QuestDB ready!');

        console.log(`\n=== First Run (API + Cache Insert) ===`);
        console.log(`Testing token info for ${contractAddress} on ${chain}...`);
        const data = await tokenService.getTokenInfo(contractAddress, chain);
        console.log('Success! Response:', JSON.stringify(data, null, 2));

        console.log(`\n=== Second Run (DB Cache Hit) ===`);
        const cachedData = await tokenService.getTokenInfo(contractAddress, chain);
        console.log('Cached Response:', JSON.stringify(cachedData, null, 2));
        console.log('\n✅ Test complete! Check QuestDB console for inserted data.');
    } catch (error: any) {
        console.error('❌ Test failed:', error);
        if (error.message.includes('ECONNREFUSED')) {
            console.log('\n💡 Tip: Ensure QuestDB Docker is running (docker ps | grep questdb).');
        } else if (error.message.includes('ChainInsight API') || error.status === 401) {
            console.log('\n💡 Tip: Check API key in .env or trial limits (status 401 = missing/invalid key).');
        } else if (error.message.includes('dateadd')) {
            console.log('\n💡 Tip: Update SQL syntax in services (use \'h\' for hour, \'m\' for minute).');
        }
    } finally {
        await questdbService.close();  // Clean shutdown
    }
}

testTokenInfo();