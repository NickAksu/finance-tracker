import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Workers AI в тестах не вызываем — без удалённого прокси
        remoteBindings: false,
        miniflare: {
          // Тесты не ходят в реальные сервисы: секреты подменены
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN",
            GEMINI_API_KEY: "test-gemini-key",
            WEBHOOK_SECRET: "test-webhook-secret",
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
