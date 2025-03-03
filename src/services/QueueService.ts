import { logger } from "../logger";

export interface QueuedMessage {
	id: string;
	type: "message" | "metrics";
	payload: {
		chat_id: string;
		text: string;
		parse_mode?: string;
	};
	attempts: number;
	lastAttempt?: Date;
	createdAt: Date;
}

export class QueueService {
	private queue: QueuedMessage[] = [];
	private isProcessing = false;
	private maxAttempts = 10;
	private retryDelays = [
		1000, // 1 second
		5000, // 5 seconds
		30000, // 30 seconds
		60000, // 1 minute
		300000, // 5 minutes
		900000, // 15 minutes
		3600000, // 1 hour
	];

	constructor(
		private readonly sendMessage: (params: {
			chat_id: string;
			text: string;
			parse_mode?: string;
		}) => Promise<void>,
	) {
		setInterval(() => this.processQueue(), 10000);
	}

	public async addToQueue(
		type: "message" | "metrics",
		payload: { chat_id: string; text: string; parse_mode?: string },
	): Promise<string> {
		const id = crypto.randomUUID();
		const message: QueuedMessage = {
			id,
			type,
			payload,
			attempts: 0,
			createdAt: new Date(),
		};

		this.queue.push(message);
		logger.debug({ messageId: id, type }, "Message added to queue");

		this.processQueue();

		return id;
	}

	private async processQueue() {
		if (this.isProcessing || this.queue.length === 0) return;
		this.isProcessing = true;

		try {
			const now = new Date();
			const messages = [...this.queue];
			this.queue = [];

			for (const message of messages) {
				if (message.lastAttempt) {
					const delay = this.getRetryDelay(message.attempts);
					if (now.getTime() - message.lastAttempt.getTime() < delay) {
						this.queue.push(message);
						continue;
					}
				}

				try {
					await this.sendMessage(message.payload);
				} catch (error) {
					logger.error(
						{ error, messageId: message.id },
						"Failed to process queued message",
					);

					if (message.attempts < this.maxAttempts) {
						message.attempts++;
						message.lastAttempt = new Date();
						this.queue.push(message);

						const nextRetry = this.getRetryDelay(message.attempts);
						logger.info(
							{
								messageId: message.id,
								nextRetryIn: nextRetry / 1000,
							},
							"Message requeued for retry",
						);
					} else {
						logger.error(
							{
								messageId: message.id,
								attempts: message.attempts,
							},
							"Message exceeded maximum retry attempts",
						);
					}
				}
			}
		} finally {
			this.isProcessing = false;
		}
	}

	private getRetryDelay(attempts: number): number {
		const index = Math.min(attempts - 1, this.retryDelays.length - 1);
		return this.retryDelays[index];
	}

	public getQueueStatus() {
		return {
			totalMessages: this.queue.length,
			messagesByType: this.queue.reduce(
				(acc, msg) => {
					acc[msg.type] = (acc[msg.type] || 0) + 1;
					return acc;
				},
				{} as Record<string, number>,
			),
			oldestMessage:
				this.queue.length > 0 ? this.queue[0].createdAt : null,
		};
	}
}
