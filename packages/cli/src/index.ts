import { Command } from "commander";
import { z } from "zod";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sendTelegramMessage } from "@mrb-dev/sendkit-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const program = new Command();
const configPath = join(homedir(), ".config", "sendkit", "config.json");
const cliConfigSchema = z.object({
  telegramBotToken: z.string().min(1).optional(),
});

function writeTelegramBotToken(token: string) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ telegramBotToken: token }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function getTelegramBotToken() {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}. Please set the TELEGRAM_BOT_TOKEN environment variable by running 'sendkit init --telegram-bot-token <botToken>'.`,
    );
  }

  const config = cliConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf-8")));
  const token = config.telegramBotToken;

  if (!token) {
    throw new Error(
      `Telegram bot token not found in config file at ${configPath}. Please set the TELEGRAM_BOT_TOKEN environment variable or create the config file.`,
    );
  }

  return token;
}

program.name("sendkit").description("SendKit CLI backed by sendkit-core");

program
  .command("init")
  .description("Configure SendKit CLI local settings")
  .requiredOption("--telegram-bot-token <botToken>", "Telegram bot token")
  .action(async (options: { telegramBotToken: string }) => {
    writeTelegramBotToken(options.telegramBotToken);
    console.log(`Telegram bot token saved to ${configPath}`);
  });

program
  .command("telegram")
  .description("Send a Telegram message")
  .argument("<chatId>", "Telegram chat ID")
  .argument("<message>", "Message text to send")
  .action(async (chatId: string, message: string) => {
    const result = await sendTelegramMessage({
      botToken: getTelegramBotToken(),
      chatId: chatId,
      message: message,
    });

    console.log(JSON.stringify(result, null, 2));
  });

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
