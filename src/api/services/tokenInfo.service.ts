import { TokenInfoResponse } from "../../models/token.types";
import { PriceService } from "../../services/tokenPriceService";
import { TokenService } from "../../services/tokenService";


class tokenInfoServiceApi {
    constructor() {
        this.getTokenInfo = this.getTokenInfo.bind(this);
    }
    async getTokenInfo(contractAddress: string) {
        const tokenService = new TokenService();
        const tokenInfo = await tokenService.getTokenInfo(contractAddress);
        const priceService = new PriceService();
        const priceData = await priceService.getRealTimePrice(contractAddress);
        const result = {
            title: tokenInfo.narrative.symbol,
            contractAddress: contractAddress,
            description: tokenInfo.narrative.narrative,
            priceUsd: priceData.priceUsd,
            volume: priceData.volume,
            marketCap: priceData.marketCap,
            telegramChannels: tokenInfo.calls.callChannelInfo?.callChannels,
            kolTwitters: tokenInfo.community.communityAttentionInfo?.communityAttentions,
            alertChange: tokenInfo.community.alertChanceInfo?.alertChances,
            kolCalls: tokenInfo.community.kolCallInfo?.kolCalls,
            communityAttention: tokenInfo.community.communityAttentionInfo?.communityAttentions,
            safetyChecklist: {
                isWarning: tokenInfo.honeypot?.simulationResult?.sellTax >= 50,
                airDropSummary: tokenInfo.honeypot?.airdropSummary,
                summery: tokenInfo.honeypot?.summary,
                isHoneyPot: tokenInfo.honeypot?.honeypotResult?.isHoneypot,
                simulationResult: tokenInfo.honeypot?.simulationResult,
                holderAnalysis: tokenInfo.honeypot?.holderAnalysis,


            },
        }
        console.log(tokenInfo, "result");
        return result;
    }
}

export const tokenInfoApiService = new tokenInfoServiceApi();