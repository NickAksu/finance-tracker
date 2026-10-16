// Регистрирует вебхук, команды и кнопку меню бота.
//   npm run set-webhook            — dev-бот (.dev.vars)
//   npm run set-webhook -- --prod  — prod-бот (.prod.vars, env.production)
// Секреты читаются из файлов и не печатаются.
import { readFileSync } from "node:fs";

const prod = process.argv.includes("--prod");
const secrets = readVars(prod ? ".prod.vars" : ".dev.vars");
const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8")) as {
  vars: { PUBLIC_URL: string };
  env: { production: { vars: { PUBLIC_URL: string } } };
};
const publicUrl = (prod ? config.env.production.vars : config.vars).PUBLIC_URL;
const token = required(secrets, "TELEGRAM_BOT_TOKEN");

async function call(method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

await call("setWebhook", {
  url: `${publicUrl}/webhook`,
  secret_token: required(secrets, "WEBHOOK_SECRET"),
  allowed_updates: ["message", "callback_query", "my_chat_member"],
  max_connections: 10,
});

const privateCommands = [
  { command: "start", description: "Начать / перезапустить" },
  { command: "invite", description: "Пригласить участника в семью" },
  { command: "help", description: "Справка" },
];
await call("setMyCommands", { commands: privateCommands, scope: { type: "all_private_chats" } });
await call("setMyCommands", {
  commands: [{ command: "help", description: "Справка" }],
  scope: { type: "all_group_chats" },
});

// Кнопка меню в личном чате открывает Mini App
await call("setChatMenuButton", { menu_button: { type: "web_app", text: "📊 Открыть", web_app: { url: publicUrl } } });

const info = (await call("getWebhookInfo", {})) as Record<string, unknown>;
console.log(`${prod ? "prod" : "dev"}: вебхук ${info.url}, в очереди ${info.pending_update_count}`);
if (info.last_error_message) console.log(`последняя ошибка: ${info.last_error_message}`);

function readVars(path: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1]!, m[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return vars;
}

function required(vars: Map<string, string>, key: string): string {
  const v = vars.get(key);
  if (!v) throw new Error(`${key} не задан`);
  return v;
}

/** JSON с комментариями: вырезает строчные и блочные комментарии вне строк. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
