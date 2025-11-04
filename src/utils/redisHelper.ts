
import Redis from "ioredis";
import dotconfig from "dotenv";
dotconfig.config();

const NODE_ENV = process.env.NODE_ENV || "development";

export const redis = new Redis({
    host: NODE_ENV === "development" ? process.env.REDIS_HOST : "localhost",
    port: NODE_ENV === "development" ? Number(process.env.REDIS_PORT) : 6379,
    connectTimeout: 10000,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
});

redis.on("error", (err: Error) => {
    console.error(`Redis connection error: ${err.message}`);
});