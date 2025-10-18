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
import { SecurityService } from './services/securityService';
import { PriceService } from './services/tokenPriceService';

async function testTokenInfo() {
    const tokenService = new TokenService();
    const contractAddress = '0x6a0A9D927eBdC6e58d09D7D3C5B351b0E47b4444'; // USDT on BSC
    const chain = 'BSC';

    try {
        console.log(`Initializing QuestDB...`);
        await questdbService.init();  // Await DB init (connects Sender + PG)
        console.log('QuestDB ready!');

        console.log(`\n=== First Run (API + Cache Insert) ===`);
        console.log(`Testing token info for ${contractAddress} on ${chain}...`);
        const data = await tokenService.getTokenInfo(contractAddress, chain);
        console.log('Success! Response:', JSON.stringify(data, null, 2));


        const priceService = new PriceService();
        const price = await priceService.getRealTimePrice(contractAddress, 'BSC');
        console.log('Price:', price);

        const securityService = new SecurityService();
        const security = await securityService.checkSecurity(['0x123...exampleWallet'], 'BSC');
        console.log('Security:', security);
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