import { Command } from "commander";
import { sendTelegramMessage } from "sendkit-core";

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
      const result = await sendTelegramMessage({
        botToken: token,
        chatId: chatId,
        message: message,
      });

      console.log("Message sent successfully:", result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("Error sending Telegram message:", detail);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
