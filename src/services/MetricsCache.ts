import { SOURCES } from "@/source";
import { logger } from "../logger";

export interface DashboardMetrics {
	id: string;
	name: string;
	totalBoards: number;
	newBoardsToday: number;
	totalUsers: number;
	newUsersToday: number;
	totalBoardEvents: number;
	firstPaymentsToday: number;
	renewalsToday: number;
	totalPayingUsers: number;
	lastUpdated: Date;
}

export class MetricsCache {
	private metrics: DashboardMetrics[] = [];

	public async updateMetrics() {
		this.metrics = (
			await Promise.allSettled(
				SOURCES.map(async source => {
					const res = await fetch(source.link);
					const json = (await res.json()) as Omit<
						DashboardMetrics,
						"lastUpdated" | "id" | "name"
					>;
					return {
						...json,
						id: source.id,
						name: source.name,
						lastUpdated: new Date(),
					};
				}),
			)
		)
			.filter(res => res.status === "fulfilled")
			.map(res => res.value);
		logger.debug("Metrics cache updated");
	}

	public getMetrics(sourceId: string): DashboardMetrics | null {
		return this.metrics.find(m => m.id === sourceId) || null;
	}

	public formatMetrics(sourceId: string): string {
		if (this.metrics.length === 0) {
			return "No metrics data available yet. Metrics are updated every 12 hours at 11:00 and 23:00.";
		}

		const metrics = this.getMetrics(sourceId);
		if (!metrics) {
			return `No metrics data available for source: ${sourceId}`;
		}
		const { lastUpdated, ...data } = metrics;
		const formattedDate = lastUpdated.toLocaleString("en-US", {
			dateStyle: "short",
			timeStyle: "short",
		});

		return `📊 Dashboard Metrics (Last updated: ${formattedDate}, env: ${data.name}):
• Total Boards: ${data.totalBoards}
• New Boards Today: ${data.newBoardsToday}
• Total Users: ${data.totalUsers}
• New Users Today: ${data.newUsersToday}
• Total Board Events: ${data.totalBoardEvents}
• First Payments Today: ${data.firstPaymentsToday}
• Renewals Today: ${data.renewalsToday}
• Total Paying Users: ${data.totalPayingUsers}

Note: Metrics are updated every 12 hours at 11:00 and 23:00 or when the server is rebooted.`;
	}
}
