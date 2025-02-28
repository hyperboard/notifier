import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const telegramChats = pgTable("telegram_chats", {
    chatId: text("chat_id").primaryKey(),
    createdAt: timestamp("created_at").defaultNow(),
});
