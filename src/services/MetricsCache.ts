import { logger } from "../logger";

export interface DashboardMetrics {
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
	private metrics: DashboardMetrics | null = null;

	public updateMetrics(metrics: Omit<DashboardMetrics, "lastUpdated">) {
		this.metrics = {
			...metrics,
			lastUpdated: new Date(),
		};
		logger.debug("Metrics cache updated");
	}

	public getMetrics(): DashboardMetrics | null {
		return this.metrics;
	}

	public formatMetrics(): string {
		if (!this.metrics) {
			return "No metrics data available yet. Metrics are updated every 12 hours at 11:00 and 23:00.";
		}

		const { lastUpdated, ...data } = this.metrics;
		const formattedDate = lastUpdated.toLocaleString("en-US", {
			dateStyle: "short",
			timeStyle: "short",
		});

		return `📊 Dashboard Metrics (Last updated: ${formattedDate}):
• Total Boards: ${data.totalBoards}
• New Boards Today: ${data.newBoardsToday}
• Total Users: ${data.totalUsers}
• New Users Today: ${data.newUsersToday}
• Total Board Events: ${data.totalBoardEvents}
• First Payments Today: ${data.firstPaymentsToday}
• Renewals Today: ${data.renewalsToday}
• Total Paying Users: ${data.totalPayingUsers}

Note: Metrics are updated every 12 hours at 11:00 and 23:00.`;
	}
}
