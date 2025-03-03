# Notifier Service

This service provides notification capabilities for the Miroboard server, primarily through Telegram. It sends logs, error reports, and metrics to a designated Telegram group chat.

## Features

-   Sends notifications to a single Telegram group chat
-   Provides metrics dashboard on demand
-   Handles error reporting with detailed context
-   Exposes a simple HTTP API for sending notifications

## Setup

### Environment Variables

Copy the `.env.example` file to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Required environment variables:

-   `TELEGRAM_BOT_TOKEN`: Your Telegram bot token (get it from [@BotFather](https://t.me/botfather))
-   `TELEGRAM_GROUP_CHAT_ID`: The ID of the Telegram group chat where notifications will be sent
-   `TELEGRAM_ENABLED`: Set to `true` to enable Telegram notifications, `false` to disable
-   `APP_ENV`: Environment (`development`, `staging`, or `production`)
-   `PORT`: Port for the HTTP server

### Creating a Telegram Bot

1. Talk to [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the instructions to create a new bot
3. Copy the token provided by BotFather and set it as `TELEGRAM_BOT_TOKEN` in your `.env` file

### Getting the Group Chat ID

1. Add your bot to a Telegram group
2. Send a message in the group mentioning the bot (e.g., `/hello@your_bot_name`)
3. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in your browser
4. Look for the `chat` object in the response and find the `id` field - this is your group chat ID
5. Set this ID as `TELEGRAM_GROUP_CHAT_ID` in your `.env` file

## Implementation Details

The service uses:

-   [Grammy.js](https://grammy.dev/) for Telegram bot functionality
-   [Hono](https://hono.dev/) for the HTTP server
-   Top-level await with an async main function to properly initialize both services

## Running the Service

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

## API Endpoints

### POST /notify

Send a notification to the Telegram group chat.

```json
{
	"text": "Your notification message",
	"meta": {
		"boardId": "optional-board-id",
		"operationContext": {
			// Optional operation context
		},
		"errorContext": {
			// Optional error context
		}
	}
}
```

### POST /metrics

Update metrics and send a formatted metrics report to the Telegram group chat.

```json
{
	"totalBoards": 100,
	"newBoardsToday": 5,
	"totalUsers": 50,
	"newUsersToday": 3,
	"totalBoardEvents": 1000,
	"firstPaymentsToday": 2,
	"renewalsToday": 1,
	"totalPayingUsers": 10
}
```

## Bot Commands

The bot supports the following commands in the Telegram group:

-   `/start` - Get a welcome message
-   `/metrics` - Get the latest metrics dashboard
-   `/hello` - Get the chat ID (useful for setup)
