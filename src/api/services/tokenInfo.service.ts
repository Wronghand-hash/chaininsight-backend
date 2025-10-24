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
                honeypot: {
                    isWarning: tokenInfo.honeypot?.simulationResult?.sellTax >= 50,
                    message: (!tokenInfo.honeypot && (!tokenInfo.pairs || tokenInfo.pairs.length === 0)) ? "no liquidity pair found for token on honeypot" : undefined,
                    airDropSummary: tokenInfo.honeypot?.airdropSummary,
                    summery: tokenInfo.honeypot?.summary,
                    isHoneyPot: tokenInfo.honeypot?.honeypotResult?.isHoneypot,
                    simulationResult: tokenInfo.honeypot?.simulationResult,
                    holderAnalysis: tokenInfo.honeypot?.holderAnalysis,
                },
                goplusSecurity: {
                    isWarning: tokenInfo.goplusSecurity?.sell_tax >= 50,
                    antiWhaleModifiable: tokenInfo.goplusSecurity?.anti_whale_modifiable === "0" ? false : true,
                    buyTax: tokenInfo.goplusSecurity?.buy_tax,
                    canTakeBackOwnership: tokenInfo.goplusSecurity?.can_take_back_ownership,
                    cannotBuy: tokenInfo.goplusSecurity?.cannot_buy,
                    cannotSellAll: tokenInfo.goplusSecurity?.cannot_sell_all,
                    creatorAddress: tokenInfo.goplusSecurity?.creator_address,
                    creatorBalance: tokenInfo.goplusSecurity?.creator_balance,
                    creatorPercent: tokenInfo.goplusSecurity?.creator_percent,
                    dex: tokenInfo.goplusSecurity?.dex,
                    externalCall: tokenInfo.goplusSecurity?.external_call,
                    hiddenOwner: tokenInfo.goplusSecurity?.hidden_owner,
                    holderCount: tokenInfo.goplusSecurity?.holder_count,
                    holders: tokenInfo.goplusSecurity?.holders,
                    honeypotWithSameCreator: tokenInfo.goplusSecurity?.honeypot_with_same_creator,
                    isAntiWhale: tokenInfo.goplusSecurity?.is_anti_whale,
                    isBlacklisted: tokenInfo.goplusSecurity?.is_blacklisted,
                    isHoneypot: tokenInfo.goplusSecurity?.is_honeypot,
                    isInDex: tokenInfo.goplusSecurity?.is_in_dex,
                    isMintable: tokenInfo.goplusSecurity?.is_mintable,
                    isOpenSource: tokenInfo.goplusSecurity?.is_open_source,
                    isWhitelisted: tokenInfo.goplusSecurity?.is_whitelisted,
                    lpHolderCount: tokenInfo.goplusSecurity?.lp_holder_count,
                    lpHolders: tokenInfo.goplusSecurity?.lp_holders,
                    lpTotalSupply: tokenInfo.goplusSecurity?.lp_total_supply,
                    ownerAddress: tokenInfo.goplusSecurity?.owner_address,
                    ownerBalance: tokenInfo.goplusSecurity?.owner_balance,
                    ownerChangeBalance: tokenInfo.goplusSecurity?.owner_change_balance,
                    ownerPercent: tokenInfo.goplusSecurity?.owner_percent,
                    personalSlippageModifiable: tokenInfo.goplusSecurity?.personal_slippage_modifiable,
                    selfdestruct: tokenInfo.goplusSecurity?.selfdestruct,
                    sellTax: tokenInfo.goplusSecurity?.sell_tax,
                    slippageModifiable: tokenInfo.goplusSecurity?.slippage_modifiable,
                    totalSupply: tokenInfo.goplusSecurity?.total_supply,
                    transferTax: tokenInfo.goplusSecurity?.transfer_tax
                },
            },
        }
        console.log(tokenInfo, "result");
        return result;
    }
}

export const tokenInfoApiService = new tokenInfoServiceApi();