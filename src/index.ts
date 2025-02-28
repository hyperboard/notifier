import { Hono } from "hono";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { telegramChats } from "./db/schema";
import { logger } from "./logger";
import { prettyJSON } from "hono/pretty-json";
import { timing } from "hono/timing";
import { MetricsCache, DashboardMetrics } from "./services/MetricsCache";

dotenv.config();

const app = new Hono();

if (process.env.NODE_ENV !== "production") {
    app.use("*", prettyJSON());
}

app.use("*", timing());
app.use("*", async (c, next) => {
    const start = Date.now();
    try {
        await next();
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
            {
                err: {
                    message: error.message,
                    stack: error.stack,
                },
                path: c.req.path,
                method: c.req.method,
                query: Object.fromEntries(new URL(c.req.url).searchParams),
            },
            "Request error"
        );
        throw err;
    }

    const ms = Date.now() - start;
    const status = c.res.status;

    if (status >= 400) {
        logger.error(
            {
                path: c.req.path,
                method: c.req.method,
                status,
                duration: `${ms}ms`,
                query: Object.fromEntries(new URL(c.req.url).searchParams),
            },
            "Request failed"
        );
    } else {
        logger.info(
            {
                path: c.req.path,
                method: c.req.method,
                status,
                duration: `${ms}ms`,
            },
            "Request completed"
        );
    }
});

interface TelegramMessage {
    text: string;
    meta?: {
        boardId?: string;
        operationContext?: {
            boardId: string;
            itemId: string;
            requestType: string;
            startTime: number;
            model?: string;
            pipelineSteps?: Array<{ name: string; status: "success" | "error" | "pending" }>;
        };
        errorContext?: {
            boardId: string;
            chatId: string;
            timestamp: string;
            activeOperations: Array<{
                itemId: string;
                boardId: string;
                requestType: string;
                startTime: number;
                model?: string;
            }>;
            activeStreams: string[];
        };
    };
}

class TelegramNotifier {
    private token: string;
    private baseUrl: string;
    private isEnabled: boolean;
    private messageQueue: Array<{ chatId: string; message: string; options: any }> = [];
    private isProcessingQueue = false;
    private readonly RATE_LIMIT_DELAY = 1000; // 1 second between messages
    private source: "development" | "staging" | "production";
    private appToken: string;
    private metricsCache: MetricsCache;

    constructor(config: {
        token: string;
        appToken: string;
        isEnabled?: boolean;
        source: "development" | "staging" | "production";
    }) {
        console.log(config);
        this.token = config.token;
        this.appToken = config.appToken;
        this.baseUrl = `https://api.telegram.org/bot${config.token}`;
        this.isEnabled = config.isEnabled ?? true;
        this.source = config.source;
        this.metricsCache = new MetricsCache();
        logger.info(`TelegramNotifier initialized with source: ${this.source}`);
    }

    private async retryWithBackoff<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        let lastError: Error;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.warn(
                    {
                        error: lastError.message,
                        attempt: i + 1,
                    },
                    `Retry ${i + 1}/${maxRetries} failed`
                );

                if (i < maxRetries - 1) {
                    const delay = Math.min(1000 * Math.pow(2, i), 10000);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError!;
    }

    private async sendTelegramRequest(method: string, params: any = {}): Promise<any> {
        if (!this.isEnabled) {
            logger.debug(`Telegram disabled: skipping ${method} request`);
            return { ok: true, result: [] };
        }

        return this.retryWithBackoff(async () => {
            try {
                logger.debug({ method, params }, "Sending request to Telegram API");
                const response = await fetch(`${this.baseUrl}/${method}`, {
                    method: params ? "POST" : "GET",
                    headers: params ? { "Content-Type": "application/json" } : undefined,
                    body: params ? JSON.stringify(params) : undefined,
                });

                if (!response.ok) {
                    throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
                }

                return await response.json();
            } catch (error) {
                logger.error({ error, method }, "Telegram API request failed");
                throw error;
            }
        });
    }

    private async processMessageQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            if (!msg) continue;

            try {
                await this.sendTelegramRequest("sendMessage", {
                    chat_id: msg.chatId,
                    text: msg.message,
                    ...msg.options,
                });
                await new Promise((resolve) => setTimeout(resolve, this.RATE_LIMIT_DELAY));
            } catch (error) {
                logger.error({ error, chatId: msg.chatId }, "Failed to process queued message");
            }
        }

        this.isProcessingQueue = false;
    }

    async start() {
        if (!this.isEnabled) {
            logger.info("Telegram bot disabled");
            return;
        }

        try {
            logger.info("Starting Telegram bot...");
            const botInfo = await this.sendTelegramRequest("getMe");
            logger.info(`Telegram bot link: https://t.me/${botInfo.result.username}`);

            await this.setupCommands();
            this.startPolling();

            logger.info("Telegram bot started successfully");
        } catch (error) {
            logger.error("Failed to start Telegram bot:", error);
            throw error;
        }
    }

    private async setupCommands() {
        const commands = [
            { command: "start", description: "Start the bot" },
            { command: "subscribe", description: "Subscribe to error reports" },
            { command: "unsubscribe", description: "Unsubscribe from error reports" },
            { command: "metrics", description: "Get metrics dashboard" },
        ];

        try {
            await this.sendTelegramRequest("setMyCommands", { commands });
            logger.info("Bot commands set successfully");
        } catch (error) {
            logger.error("Failed to set bot commands:", error);
        }
    }

    private startPolling() {
        let offset = 0;
        const poll = async () => {
            try {
                const updates = await this.sendTelegramRequest("getUpdates", {
                    offset,
                    timeout: 30,
                });

                for (const update of updates.result) {
                    offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            } catch (error) {
                logger.error("Error in polling updates:", error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            poll();
        };

        poll();
    }

    private async handleUpdate(update: any) {
        if (!update.message?.text || !update.message?.chat?.id) return;

        const chatId = update.message.chat.id.toString();
        const text = update.message.text;
        const [command] = text.split(" ");

        if (command !== "/start" && command !== "/subscribe") {
            const isSubscribed = await this.isSubscribed(chatId);
            if (!isSubscribed) {
                await this.sendTelegramRequest("sendMessage", {
                    chat_id: chatId,
                    text: "🔒 This is a private developer log chat. You need to subscribe first using the command:\n/subscribe <app-token>",
                });
                return;
            }
        }

        switch (command) {
            case "/start":
                await this.sendTelegramRequest("sendMessage", {
                    chat_id: chatId,
                    text: "Hello! Use /subscribe <app-token> to subscribe to error reports.",
                });
                break;

            case "/subscribe":
                const token = text.split(" ")[1];
                if (!token) {
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: "Please provide an app token: /subscribe <app-token>",
                    });
                    return;
                }

                if (token !== this.appToken) {
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: "Invalid app token",
                    });
                    return;
                }

                try {
                    await this.addChat(chatId);
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: `Successfully subscribed to error reports! (Source: ${this.source})`,
                    });
                } catch (error) {
                    logger.error("Failed to subscribe chat:", error);
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: "Failed to subscribe. Please try again later.",
                    });
                }
                break;

            case "/unsubscribe":
                try {
                    await this.removeChat(chatId);
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: "Successfully unsubscribed from error reports!",
                    });
                } catch (error) {
                    logger.error("Failed to unsubscribe chat:", error);
                    await this.sendTelegramRequest("sendMessage", {
                        chat_id: chatId,
                        text: "Failed to unsubscribe. Please try again later.",
                    });
                }
                break;

            case "/metrics":
                const formattedMetrics = this.metricsCache.formatMetrics();
                await this.sendTelegramRequest("sendMessage", {
                    chat_id: chatId,
                    text: formattedMetrics,
                    parse_mode: "Markdown",
                });
                break;
        }
    }

    async broadcastMessage(text: string, meta?: TelegramMessage["meta"]) {
        if (!this.isEnabled) {
            logger.info("Broadcast skipped - Telegram service is disabled");
            return;
        }

        const message: TelegramMessage = { text, meta };
        const formattedMessage = this.formatMessage(message);

        try {
            const chats = await db.select().from(telegramChats);

            for (const chat of chats) {
                this.messageQueue.push({
                    chatId: chat.chatId,
                    message: formattedMessage,
                    options: { parse_mode: "Markdown" },
                });
            }

            this.processMessageQueue();
        } catch (error) {
            logger.error("Failed to fetch chats for broadcast:", error);
            throw error;
        }
    }

    private formatMessage(message: TelegramMessage): string {
        const parts: string[] = [message.text];

        if (message.meta?.boardId) {
            parts.push(`\n[#] Board: ${message.meta.boardId}`);
        }

        if (message.meta?.operationContext) {
            const ctx = message.meta.operationContext;
            parts.push(`
⚙ Operation Details:
• Type: ${ctx.requestType}
• Model: ${ctx.model || "N/A"}
• Duration: ${Date.now() - ctx.startTime}ms`);

            if (ctx.pipelineSteps) {
                const steps = ctx.pipelineSteps
                    .map((step) => {
                        const icon = step.status === "success" ? "🗸" : step.status === "error" ? "✗" : "…";
                        return `${icon} ${step.name}`;
                    })
                    .join("\n");
                parts.push(`\n⚡ Pipeline Status:\n${steps}`);
            }
        }

        if (message.meta?.errorContext) {
            const ctx = message.meta.errorContext;
            parts.push(`
⚠ Error Details:
• Board: ${ctx.boardId}
• Chat: ${ctx.chatId}
• Time: ${ctx.timestamp}
• Active Operations: ${ctx.activeOperations.length}
• Active Streams: ${ctx.activeStreams.length}`);
        }

        return this.truncateMessage(parts.join(""));
    }

    private truncateMessage(message: string): string {
        const MAX_LENGTH = 4096;
        if (message.length > MAX_LENGTH) {
            return message.substring(0, MAX_LENGTH - 100) + "\n... [message truncated]";
        }
        return message;
    }

    private async isSubscribed(chatId: string): Promise<boolean> {
        const chat = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
        return chat.length > 0;
    }

    async addChat(chatId: string) {
        try {
            logger.info(`Adding chat ${chatId} to database`);
            const result = await db
                .insert(telegramChats)
                .values({ chatId: `${chatId}` })
                .onConflictDoNothing()
                .returning({ insertedId: telegramChats.chatId });

            logger.info(`Chat ${chatId} added successfully:`, result);

            const chat = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);

            logger.info(`Verification query result:`, chat);
        } catch (error) {
            logger.error(`Failed to add chat ${chatId}:`, error);
            throw error;
        }
    }

    async removeChat(chatId: string) {
        await db.delete(telegramChats).where(eq(telegramChats.chatId, chatId));
    }

    public updateMetricsCache(metrics: Omit<DashboardMetrics, "lastUpdated">) {
        this.metricsCache.updateMetrics(metrics);
        return this.metricsCache.formatMetrics();
    }
}

const telegramNotifier = new TelegramNotifier({
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    appToken: process.env.TELEGRAM_APP_TOKEN || "",
    isEnabled: process.env.TELEGRAM_ENABLED !== "false",
    source: (process.env.NODE_ENV as "development" | "staging" | "production") || "development",
});

await telegramNotifier.start().catch(console.error);

app.post("/notify", zValidator("json", z.object({ text: z.string(), meta: z.any().optional() })), async (c) => {
    try {
        const body = await c.req.json<TelegramMessage>();
        await telegramNotifier.broadcastMessage(body.text, body.meta);
        return c.json({ success: true });
    } catch (error) {
        logger.error({ error }, "Notification error");
        return c.json({ success: false, error: "Failed to send notification" }, 500);
    }
});

app.post(
    "/metrics",
    zValidator(
        "json",
        z.object({
            totalBoards: z.number(),
            newBoardsToday: z.number(),
            totalUsers: z.number(),
            newUsersToday: z.number(),
            totalBoardEvents: z.number(),
            firstPaymentsToday: z.number(),
            renewalsToday: z.number(),
            totalPayingUsers: z.number(),
        })
    ),
    async (c) => {
        try {
            const metrics = c.req.valid("json");
            const formattedMessage = telegramNotifier.updateMetricsCache(metrics);
            await telegramNotifier.broadcastMessage(formattedMessage);
            return c.json({ success: true });
        } catch (error) {
            logger.error({ error }, "Metrics error");
            return c.json({ success: false, error: "Failed to send metrics" }, 500);
        }
    }
);

app.post("/admin/chats", async (c) => {
    try {
        const { chatId } = await c.req.json<{ chatId: string }>();
        await telegramNotifier.addChat(chatId);
        return c.json({ success: true });
    } catch (error) {
        logger.error({ error }, "Failed to add chat");
        return c.json({ success: false, error: "Failed to add chat" }, 500);
    }
});

app.delete("/admin/chats/:chatId", async (c) => {
    try {
        const chatId = c.req.param("chatId");
        await telegramNotifier.removeChat(chatId);
        return c.json({ success: true });
    } catch (error) {
        logger.error({ error }, "Failed to remove chat");
        return c.json({ success: false, error: "Failed to remove chat" }, 500);
    }
});

const port = process.env.PORT || 3000;
logger.info(`Server is running on port ${port}`);

serve({
    fetch: app.fetch,
    port: Number(port),
});

process.on("uncaughtException", (error) => {
    logger.fatal(
        {
            err: {
                message: error.message,
                stack: error.stack,
            },
        },
        "Uncaught exception"
    );
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.fatal(
        {
            err:
                reason instanceof Error
                    ? {
                          message: reason.message,
                          stack: reason.stack,
                      }
                    : reason,
        },
        "Unhandled rejection"
    );
    process.exit(1);
});
