import { Command } from "commander";

type TelegramResponse = {
  ok: boolean;
  result?: {
    message_id: number;
  };
  description?: string;
}

const program = new Command();

program
  .name("sendkit")
  .description("SendKit tutorial CLI")
  .command("telegram")
  .description("Send a Telegram message")
  .argument("<chatId>", "Telegram chat ID")
  .argument("<message>", "Message text to send")
  .action(async (chatId: string, message: string) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      console.error("Error: TELEGRAM_BOT_TOKEN is not set in the environment variables.");
      process.exit(1);
    }

    if (!chatId) {
      console.error("Error: chatId is required.");
      process.exit(1);
    }

    if (!message) {
      console.error("Error: message is required.");
      process.exit(1);
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
        }),
      });

      const data: TelegramResponse = await response.json();

      if (!response.ok || !data.ok) {
        console.error("Error sending message:", data.description || "Unknown error");
        process.exit(1);
      }

      const messageId = data.result?.message_id;
      console.log(`Sent Telegram message to chat ${chatId} with message ID: ${messageId}`);
    } catch (error) {
      console.error("Telegram API request failed:", error);
    }
  });

program.parseAsync(process.argv);
