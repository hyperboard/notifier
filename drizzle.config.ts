import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env" });

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

export default defineConfig({
    schema: "./src/db/schema.ts",
    out: "./src/db/migrations",
    dialect: "postgresql",
    dbCredentials: {
        host: DB_HOST || "localhost",
        port: parseInt(DB_PORT || "5432"),
        user: DB_USER || "postgres",
        password: DB_PASSWORD || "postgres",
        database: DB_NAME || "notifier",
        ssl: false,
    },
});
