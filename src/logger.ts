import pino from "pino";
import { resolve } from "path";
import fs from "fs";

const logDir = resolve(__dirname, "../logs");

if (!fs.existsSync(logDir)) {
	fs.mkdirSync(logDir, { recursive: true });
}

const fileTransport = pino.destination({
	dest: resolve(logDir, "server.log"),
	sync: false,
});

const prettyTransport = pino.transport({
	target: "pino-pretty",
	options: {
		colorize: true,
		translateTime: "SYS:standard",
		ignore: "pid,hostname",
		messageFormat: "{msg} {metadata}",
	},
});

export const logger = pino(
	{
		level: process.env.LOG_LEVEL || "debug",
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: {
			level: label => {
				return { level: label.toUpperCase() };
			},
		},
		base: undefined,
	},
	pino.multistream([
		{ stream: prettyTransport },
		{ stream: fileTransport, level: "error" },
	]),
);

prettyTransport.on("error", (error: any) => {
	console.error("Logger transport error:", error);
});

fileTransport.on("error", error => {
	console.error("File transport error:", error);
});

process.on("beforeExit", () => {
	fileTransport.flushSync();
});
