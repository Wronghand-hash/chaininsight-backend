import swaggerJsdoc from 'swagger-jsdoc';
import { version } from '../../package.json';

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'ChainInsight API Documentation',
            version,
            description: 'API documentation for ChainInsight backend services',
            contact: {
                name: 'API Support',
                url: 'https://your-support-url.com',
            },
        },
        servers: [
            {
                url: 'http://localhost:3000/api/v1',
                description: 'Development server',
            },
            {
                url: "https://tiesha-postrorse-blindfoldedly.ngrok-free.dev/api/v1",
                description: "ngrok server"
            }
        ],
        components: {
            schemas: {
                TokenInfoResponse: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', example: 'AIrena' },
                        contractAddress: { type: 'string', example: '0x3f4c5a8bed91493badc688fec1d30630a67e4444' },
                        description: {
                            type: 'string',
                            example: 'AIrena is the first AI research lab focused on the meme market...'
                        },
                        priceUsd: { type: 'string', example: '0.000008338' },
                        volume: { type: 'number', format: 'float', example: 126939.57 },
                        marketCap: { type: 'number', format: 'float', example: 8338.57 },
                        telegramChannels: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    channelLink: { type: 'string', example: 'https://t.me/haitunge1/2309390' },
                                    channelName: { type: 'string', example: '海豚🐬24小时扫链开麦沟通信息' },
                                    timestamp: { type: 'number', example: 1761240914000 }
                                }
                            }
                        },
                        kolTwitters: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    avatar: { type: 'string', example: 'https://img.chaininsight.vip/image/_4330fee1-15f4-4e5e-8350-99d2ed47fc83.jpg' },
                                    groupName: { type: 'string', example: 'CryptoD社群' },
                                    kolName: { type: 'string', example: 'CryptoD社群' },
                                    kolTwitterId: { type: 'string', example: 'CryptoDevinL' }
                                }
                            }
                        },
                        kolCalls: {
                            type: 'array',
                            items: { type: 'object' },
                            description: 'Array of KOL call objects'
                        },
                        communityAttention: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    avatar: { type: 'string', example: 'https://img.chaininsight.vip/image/_4330fee1-15f4-4e5e-8350-99d2ed47fc83.jpg' },
                                    groupName: { type: 'string', example: 'CryptoD社群' },
                                    kolName: { type: 'string', example: 'CryptoD社群' },
                                    kolTwitterId: { type: 'string', example: 'CryptoDevinL' }
                                }
                            }
                        },
                        safetyChecklist: {
                            type: 'object',
                            properties: {
                                honeypot: {
                                    type: 'object',
                                    properties: {
                                        isWarning: { type: 'boolean', example: false },
                                        message: { type: 'string', example: 'no liquidity pair found for token on honeypot' }
                                    }
                                },
                                goplusSecurity: {
                                    type: 'object',
                                    properties: {
                                        isWarning: { type: 'boolean', example: false },
                                        antiWhaleModifiable: { type: 'boolean', example: false },
                                        buyTax: { type: 'string', example: '0' },
                                        canTakeBackOwnership: { type: 'string', example: '0' },
                                        cannotBuy: { type: 'string', example: '0' },
                                        creatorAddress: { type: 'string', example: '0x6743e561deb20bb3fd64f7bb5835aaa6c4f7dc45' },
                                        creatorBalance: { type: 'string', example: '16977046.34215223' },
                                        creatorPercent: { type: 'string', example: '0.016977' },
                                        externalCall: { type: 'string', example: '0' },
                                        hiddenOwner: { type: 'string', example: '0' },
                                        holderCount: { type: 'string', example: '42' },
                                        holders: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    address: { type: 'string' },
                                                    tag: { type: 'string' },
                                                    is_contract: { type: 'number' },
                                                    balance: { type: 'string' },
                                                    percent: { type: 'string' },
                                                    is_locked: { type: 'number' }
                                                }
                                            }
                                        },
                                        isHoneypot: { type: 'string', example: '0' },
                                        isInDex: { type: 'string', example: '0' },
                                        isMintable: { type: 'string', example: '0' },
                                        isOpenSource: { type: 'string', example: '1' },
                                        ownerAddress: { type: 'string', example: '0x0000000000000000000000000000000000000000' },
                                        sellTax: { type: 'string', example: '0' },
                                        totalSupply: { type: 'string', example: '1000000000' }
                                    }
                                }
                            }
                        }
                    }
                },
                KolLeaderboardResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    rank: { type: 'number', example: 1 },
                                    walletAddress: { type: 'string', example: '0x123...' },
                                    username: { type: 'string', example: 'crypto_expert' },
                                    platform: { type: 'string', example: 'Twitter' },
                                    followers: { type: 'number', example: 50000 },
                                    engagementRate: { type: 'number', format: 'float', example: 4.5 },
                                    lastUpdate: { type: 'string', format: 'date-time' }
                                }
                            }
                        },
                        pagination: {
                            type: 'object',
                            properties: {
                                total: { type: 'number', example: 100 },
                                page: { type: 'number', example: 1 },
                                pageSize: { type: 'number', example: 10 },
                                totalPages: { type: 'number', example: 10 }
                            }
                        }
                    }
                },
                ErrorResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        error: {
                            type: 'object',
                            properties: {
                                code: { type: 'string', example: 'INVALID_INPUT' },
                                message: { type: 'string', example: 'Invalid input parameters' },
                                details: { type: 'object' }
                            }
                        }
                    }
                }
            },
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [
            {
                bearerAuth: [],
            },
        ],
    },
    apis: ['./src/api/**/*.ts'], // Path to the API routes
};

const specs = swaggerJsdoc(options);

export default specs;
