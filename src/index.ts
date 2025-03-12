import { Hono } from "hono";
import dotenv from "dotenv";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { logger } from "./logger";
import { prettyJSON } from "hono/pretty-json";
import { timing } from "hono/timing";
import { MetricsCache, DashboardMetrics } from "./services/MetricsCache";
import { Bot, GrammyError, HttpError } from "grammy";
import path from "path";
import { existsSync } from "fs";

dotenv.config();

function findEnvFile(startDir: string) {
	let currentDir = startDir;

	while (currentDir !== path.parse(currentDir).root) {
		const envPath = path.join(currentDir, ".env");
		if (existsSync(envPath)) {
			console.log("Found .env file at:", envPath);
			return envPath;
		}
		currentDir = path.dirname(currentDir);
	}

	console.log(".env file not found");
	return null;
}

const startDirectory = __dirname; // Start from the current directory
findEnvFile(startDirectory);

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
			"Request error",
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
				body: await c.req.json(),
			},
			"Request failed",
		);
	} else {
		logger.info(
			{
				path: c.req.path,
				method: c.req.method,
				status,
				duration: `${ms}ms`,
			},
			"Request completed",
		);
	}
});

interface TelegramMessage {
	text: string;
	env: string;
	meta?: {
		boardId?: string;
		msg?: Record<string, any>;
		operationContext?: {
			boardId: string;
			itemId: string;
			requestType: string;
			startTime: number;
			model?: string;
			pipelineSteps?: Array<{
				name: string;
				status: "success" | "error" | "pending";
			}>;
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
	private bot: Bot;
	private isEnabled: boolean;
	private source: string;
	private groupChatId: string;
	private metricsCache: MetricsCache;
	private messageQueue: Array<{ message: string; options?: any }> = [];
	private isProcessingQueue = false;
	private readonly RATE_LIMIT_DELAY = 1000; // 1 second between messages

	constructor(config: {
		token: string;
		isEnabled?: boolean;
		source: string;
		groupChatId: string;
	}) {
		this.bot = new Bot(config.token);
		this.isEnabled = config.isEnabled ?? true;
		this.source = config.source;
		this.groupChatId = config.groupChatId;
		this.metricsCache = new MetricsCache();

		logger.info(`TelegramNotifier initialized with source: ${this.source}`);
		logger.info(`Group chat ID: ${this.groupChatId}`);

		// Set up error handling for the bot
		this.setupErrorHandling();
	}

	private setupErrorHandling() {
		this.bot.catch(err => {
			const ctx = err.ctx;
			logger.error(
				`Error while handling update ${ctx.update.update_id}:`,
			);
			const e = err.error;
			if (e instanceof GrammyError) {
				logger.error(`Error in request: ${e.description}`);
			} else if (e instanceof HttpError) {
				logger.error(`Could not contact Telegram: ${e}`);
			} else {
				logger.error(`Unknown error: ${e}`);
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
				await this.bot.api.sendMessage(
					this.groupChatId,
					msg.message,
					msg.options,
				);
				await new Promise(resolve =>
					setTimeout(resolve, this.RATE_LIMIT_DELAY),
				);
			} catch (error) {
				logger.error({ error }, "Failed to process queued message");
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
			const botInfo = await this.bot.api.getMe();
			logger.info(`Telegram bot link: https://t.me/${botInfo.username}`);

			await this.setupCommands();

			this.setupCommandHandlers();

			this.bot.start({
				onStart: () => {
					logger.info("Telegram bot started successfully");
				},
			});
		} catch (error) {
			logger.error({ error }, "Failed to start Telegram bot:");
			throw error;
		}
	}

	private async setupCommands() {
		const commands = [
			{ command: "start", description: "Start the bot" },
			{ command: "metrics", description: "Get metrics dashboard" },
			{ command: "hello", description: "Hello" },
		];

		try {
			await this.bot.api.setMyCommands(commands);
			logger.info("Bot commands set successfully");
		} catch (error) {
			logger.error({ error }, "Failed to set bot commands:");
		}
	}

	private setupCommandHandlers() {
		this.bot.command("start", async ctx => {
			await ctx.reply(
				`Hello! This is the notification bot for ${this.source} environment.`,
			);
		});

		this.bot.command("hello", async ctx => {
			const chatId = ctx.chat.id.toString();
			logger.info(`Hello command received from chat: ${chatId}`);
			await ctx.reply(`Hello! ChatId: <code>${chatId}</code>`, {
				parse_mode: "HTML",
			});
		});

		this.bot.command("metrics", async ctx => {
			const formattedMetrics = this.metricsCache.formatMetrics();
			await ctx.reply(formattedMetrics, { parse_mode: "Markdown" });
		});
	}

	async sendMessage(
		text: string,
		env: string = "development",
		meta?: TelegramMessage["meta"],
	) {
		if (!this.isEnabled) {
			logger.info(
				"Message sending skipped - Telegram service is disabled",
			);
			return;
		}

		const message: TelegramMessage = { text, meta, env };
		const formattedMessage = this.formatMessage(message);

		try {
			this.messageQueue.push({
				message: formattedMessage,
				options: { parse_mode: "Markdown" },
			});

			this.processMessageQueue();
		} catch (error) {
			logger.error({ error }, "Failed to send message:");
			throw error;
		}
	}

	private formatMessage(message: TelegramMessage): string {
		const parts: string[] = [message.text];

		if (message.meta?.boardId) {
			parts.push(`\n\n[#] Board: ${message.meta.boardId}`);
		}

		parts.push(
			`\n\n[#] Environment: ${message.env || "unknown environment"}`,
		);

		if (message.meta?.operationContext) {
			const ctx = message.meta.operationContext;
			parts.push(`\n
⚙ Operation Details:
• Type: ${ctx.requestType}
• Model: ${ctx.model || "N/A"}
• Duration: ${Date.now() - ctx.startTime}ms`);

			if (ctx.pipelineSteps) {
				const steps = ctx.pipelineSteps
					.map(step => {
						const icon =
							step.status === "success"
								? "🗸"
								: step.status === "error"
									? "✗"
									: "…";
						return `${icon} ${step.name}`;
					})
					.join("\n");
				parts.push(`\n\n⚡ Pipeline Status:\n${steps}`);
			}
		}

		if (message.meta?.errorContext) {
			const ctx = message.meta.errorContext;
			parts.push(`\n\n
⚠ Error Details:
• Board: ${ctx.boardId}
• Chat: ${ctx.chatId}
• Time: ${ctx.timestamp}
• Active Operations: ${ctx.activeOperations.length}
• Active Streams: ${ctx.activeStreams.length}`);
		}

		if (message.meta?.msg) {
			parts.push(`\n\n
💬 Message Details:
\`\`\`json
${JSON.stringify(message.meta.msg, null, 2)}
\`\`\``);
		}

		return this.truncateMessage(parts.join(""));
	}

	private truncateMessage(message: string): string {
		const MAX_LENGTH = 4096;
		if (message.length > MAX_LENGTH) {
			return (
				message.substring(0, MAX_LENGTH - 100) +
				"\n... [message truncated]"
			);
		}
		return message;
	}

	public updateMetricsCache(metrics: Omit<DashboardMetrics, "lastUpdated">) {
		this.metricsCache.updateMetrics(metrics);
		return this.metricsCache.formatMetrics();
	}
}

async function main() {
	// Get the group chat ID from environment variables
	const groupChatId = Bun.env.TELEGRAM_GROUP_CHAT_ID;
	if (!groupChatId) {
		logger.error("TELEGRAM_GROUP_CHAT_ID environment variable is not set");
		process.exit(1);
	}

	const telegramNotifier = new TelegramNotifier({
		token: Bun.env.TELEGRAM_BOT_TOKEN || "",
		isEnabled: Bun.env.TELEGRAM_ENABLED !== "false",
		source: Bun.env.APP_ENV || "development",
		groupChatId,
	});

	// Start the bot (non-blocking)
	await telegramNotifier.start().catch(error => {
		logger.error({ error }, "Failed to start Telegram bot:");
	});

	app.post(
		"/notify",
		zValidator(
			"json",
			z.object({
				text: z.string(),
				meta: z.any().optional(),
				env: z.string(),
			}),
		),
		async c => {
			try {
				const body = await c.req.json<TelegramMessage>();
				logger.info({ body }, "notifier body");
				await telegramNotifier.sendMessage(
					body.text,
					body.env,
					body.meta,
				);
				return c.json({ success: true });
			} catch (error) {
				logger.error({ error }, "Notification error");
				return c.json(
					{ success: false, error: "Failed to send notification" },
					500,
				);
			}
		},
	);

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
				env: z.string(),
			}),
		),
		async c => {
			try {
				const metrics = c.req.valid("json");
				const formattedMessage =
					telegramNotifier.updateMetricsCache(metrics);
				await telegramNotifier.sendMessage(
					formattedMessage,
					metrics.env,
				);
				return c.json({ success: true });
			} catch (error) {
				logger.error({ error }, "Metrics error");
				return c.json(
					{ success: false, error: "Failed to send metrics" },
					500,
				);
			}
		},
	);

	const port = process.env.NOTIFIER_PORT || 3000;

	process.on("uncaughtException", error => {
		logger.fatal(
			{
				err: {
					message: error.message,
					stack: error.stack,
				},
			},
			"Uncaught exception",
		);
		process.exit(1);
	});

	process.on("unhandledRejection", reason => {
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
			"Unhandled rejection",
		);
		process.exit(1);
	});

	logger.info("Notifier service started on port " + port);

	return {
		port: Number(port),
		fetch: app.fetch,
	};
}

const server = await main();

logger.info("Notifier service started: ");

export default server;
