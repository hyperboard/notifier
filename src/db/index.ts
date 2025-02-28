import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { logger } from "../logger";

config();

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.connect()
    .then(() => {
        logger.info("Successfully connected to database");
    })
    .catch((err) => {
        logger.error("Failed to connect to database:", err);
        process.exit(1);
    });

export const db = drizzle(pool, { schema });
