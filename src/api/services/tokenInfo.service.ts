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
                    airDropSummary: tokenInfo.honeypot?.airdropSummary,
                    summery: tokenInfo.honeypot?.summary,
                    isHoneyPot: tokenInfo.honeypot?.honeypotResult?.isHoneypot,
                    simulationResult: tokenInfo.honeypot?.simulationResult,
                    holderAnalysis: tokenInfo.honeypot?.holderAnalysis,
                },
                goplusSecurity: {
                    isWarning: tokenInfo.goplusSecurity?.sell_tax >= 50,
                    anti_whale_modifiable: tokenInfo.goplusSecurity?.anti_whale_modifiable === "0" ? false : true,
                    buy_tax: tokenInfo.goplusSecurity?.buy_tax,
                    can_take_back_ownership: tokenInfo.goplusSecurity?.can_take_back_ownership,
                    cannot_buy: tokenInfo.goplusSecurity?.cannot_buy,
                    cannot_sell_all: tokenInfo.goplusSecurity?.cannot_sell_all,
                    creator_address: tokenInfo.goplusSecurity?.creator_address,
                    creator_balance: tokenInfo.goplusSecurity?.creator_balance,
                    creator_percent: tokenInfo.goplusSecurity?.creator_percent,
                    dex: tokenInfo.goplusSecurity?.dex,
                    external_call: tokenInfo.goplusSecurity?.external_call,
                    hidden_owner: tokenInfo.goplusSecurity?.hidden_owner,
                    holder_count: tokenInfo.goplusSecurity?.holder_count,
                    holders: [
                        [Object], [Object],
                        [Object], [Object],
                        [Object], [Object],
                        [Object], [Object],
                        [Object], [Object]
                    ],
                    honeypot_with_same_creator: tokenInfo.goplusSecurity?.honeypot_with_same_creator,
                    is_anti_whale: tokenInfo.goplusSecurity?.is_anti_whale,
                    is_blacklisted: tokenInfo.goplusSecurity?.is_blacklisted,
                    is_honeypot: tokenInfo.goplusSecurity?.is_honeypot,
                    is_in_dex: tokenInfo.goplusSecurity?.is_in_dex,
                    is_mintable: tokenInfo.goplusSecurity?.is_mintable,
                    is_open_source: tokenInfo.goplusSecurity?.is_open_source,
                    is_whitelisted: tokenInfo.goplusSecurity?.is_whitelisted,
                    lp_holder_count: tokenInfo.goplusSecurity?.lp_holder_count,
                    lp_holders: tokenInfo.goplusSecurity?.lp_holders,
                    lp_total_supply: tokenInfo.goplusSecurity?.lp_total_supply,
                    owner_address: tokenInfo.goplusSecurity?.owner_address,
                    owner_balance: tokenInfo.goplusSecurity?.owner_balance,
                    owner_change_balance: tokenInfo.goplusSecurity?.owner_change_balance,
                    owner_percent: tokenInfo.goplusSecurity?.owner_percent,
                    personal_slippage_modifiable: tokenInfo.goplusSecurity?.personal_slippage_modifiable,
                    selfdestruct: tokenInfo.goplusSecurity?.selfdestruct,
                    sell_tax: tokenInfo.goplusSecurity?.sell_tax,
                    slippage_modifiable: tokenInfo.goplusSecurity?.slippage_modifiable,
                    total_supply: tokenInfo.goplusSecurity?.total_supply,
                    transfer_tax: tokenInfo.goplusSecurity?.transfer_tax
                },
            },
        }
        console.log(tokenInfo, "result");
        return result;
    }
}

export const tokenInfoApiService = new tokenInfoServiceApi();