import { useEffect, useState, type ReactNode } from "react";
import type { MeResponse, MemberRole } from "../../shared/api";
import { ApiError, fetchMe } from "./lib/api";
import { getReceiptIdFromLaunch } from "./lib/telegram";
import type { TelegramWebApp } from "./telegram";

type LoadState =
  | { status: "loading" }
  | { status: "ok"; data: MeResponse }
  | { status: "error"; title: string; text: string };

const ROLE_LABEL: Record<MemberRole, string> = { owner: "владелец", member: "участник" };

function describeError(err: unknown): { title: string; text: string } {
  if (err instanceof ApiError) {
    if (err.status === 401)
      return { title: "Не удалось войти", text: "Данные Telegram устарели или неверны. Закройте и откройте приложение заново." };
    if (err.code === "not_member")
      return { title: "Вы ещё не в семье", text: "Попросите владельца прислать вам приглашение в боте." };
    if (err.status === 403)
      return { title: "Нет доступа", text: "Это приложение доступно только членам семьи." };
  }
  return { title: "Что-то пошло не так", text: "Не удалось загрузить данные. Попробуйте позже." };
}

export default function App({ webApp }: { webApp: TelegramWebApp | null }) {
  const user = webApp?.initDataUnsafe.user;
  const receiptId = getReceiptIdFromLaunch(webApp?.initDataUnsafe.start_param, window.location.pathname);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!webApp) return;
    let cancelled = false;
    fetchMe(webApp.initData)
      .then((data) => !cancelled && setState({ status: "ok", data }))
      .catch((err: unknown) => !cancelled && setState({ status: "error", ...describeError(err) }));
    return () => {
      cancelled = true;
    };
  }, [webApp]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-tg-bg p-4 text-tg-text">
      <h1 className="text-2xl font-semibold">{user ? `Привет, ${user.first_name}!` : "Семейные траты"}</h1>

      {receiptId !== null && (
        <Card>
          <p>
            Открыт чек #{receiptId} <span className="text-tg-hint">(редактор появится в фазе 5)</span>
          </p>
        </Card>
      )}

      {!webApp ? (
        <Notice title="Откройте в Telegram" text="Это мини-приложение работает только внутри Telegram: откройте его через бота." />
      ) : state.status === "loading" ? (
        <p className="text-tg-hint">Загрузка…</p>
      ) : state.status === "error" ? (
        <Notice title={state.title} text={state.text} />
      ) : (
        <Household data={state.data} />
      )}
    </main>
  );
}

function Household({ data }: { data: MeResponse }) {
  return (
    <>
      <Card>
        <p className="text-sm text-tg-hint">Семья</p>
        <p className="text-lg font-medium">{data.household.name}</p>
        <p className="text-sm text-tg-hint">
          {data.household.currency} · {data.household.timezone}
        </p>
      </Card>
      <Card>
        <p className="text-sm text-tg-hint">Вы</p>
        <p>
          {data.member.displayName} <span className="text-tg-hint">· {ROLE_LABEL[data.member.role]}</span>
        </p>
      </Card>
      <Card>
        <p className="mb-2 text-sm text-tg-hint">Участники</p>
        <ul className="flex flex-col gap-1">
          {data.members.map((m) => (
            <li key={m.telegramId} className="flex justify-between">
              <span>{m.displayName}</span>
              <span className="text-tg-hint">{ROLE_LABEL[m.role]}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-xl bg-tg-secondary-bg p-4">{children}</section>;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <Card>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-tg-hint">{text}</p>
    </Card>
  );
}
