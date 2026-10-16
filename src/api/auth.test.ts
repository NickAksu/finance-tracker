import { describe, expect, it } from "vitest";
import { signInitData } from "../../test/helpers/init-data";
import { buildDataCheckString, validateInitData } from "./auth";

const TOKEN = "123456:TEST_TOKEN";
const USER = { id: 861165606, first_name: "Николай", username: "nick", language_code: "ru" };
const now = () => Math.floor(Date.now() / 1000);

// Эталон посчитан независимо в Node (node:crypto createHmac) для токена ниже.
const FIXED_TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";
const FIXED_AUTH_DATE = 1700000000;
const FIXED_INIT_DATA =
  "auth_date=1700000000&query_id=AAHdF6IQAAAAAN0XohDhrOrc" +
  "&user=%7B%22id%22%3A861165606%2C%22first_name%22%3A%22%D0%9D%D0%B8%D0%BA%D0%BE%D0%BB%D0%B0%D0%B9%22%2C%22last_name%22%3A%22A%22%2C%22username%22%3A%22nick%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%7D" +
  "&start_param=r_123" +
  "&signature=6fbdaab833d39f54518bd5c3eb3f511d035e68cb3b1d1b4c6e1c2b2a3f3b1e2d9a8f7e6d5c4b3a291807f6e5d4c3b2a19081726354453627180918273645aa" +
  "&hash=12bc04ac1be41025486caea10ae442ed6630533f79824a2d90e3d2b465643976";

describe("validateInitData", () => {
  it("принимает корректно подписанные данные", async () => {
    const initData = await signInitData(TOKEN, { user: USER, startParam: "r_42" });
    const res = await validateInitData(initData, TOKEN);
    expect(res).toEqual({
      ok: true,
      data: { user: USER, authDate: expect.any(Number), startParam: "r_42" },
    });
  });

  it("проверяет эталонный вектор (с полем signature)", async () => {
    const res = await validateInitData(FIXED_INIT_DATA, FIXED_TOKEN, { nowSeconds: FIXED_AUTH_DATE + 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.user).toEqual({
      id: 861165606,
      first_name: "Николай",
      last_name: "A",
      username: "nick",
      language_code: "ru",
    });
    expect(res.data.authDate).toBe(FIXED_AUTH_DATE);
    expect(res.data.startParam).toBe("r_123");
  });

  it("signature входит в data-check-string: без него подпись не сходится", async () => {
    const params = new URLSearchParams(FIXED_INIT_DATA);
    params.delete("signature");
    const res = await validateInitData(params.toString(), FIXED_TOKEN, { nowSeconds: FIXED_AUTH_DATE + 10 });
    expect(res).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("отклоняет данные с другим токеном", async () => {
    const res = await validateInitData(FIXED_INIT_DATA, TOKEN, { nowSeconds: FIXED_AUTH_DATE + 10 });
    expect(res).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("отклоняет подменённые поля", async () => {
    const params = new URLSearchParams(await signInitData(TOKEN, { user: USER }));
    params.set("user", JSON.stringify({ ...USER, id: 1 }));
    expect(await validateInitData(params.toString(), TOKEN)).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("отклоняет подменённый hash", async () => {
    const params = new URLSearchParams(await signInitData(TOKEN, { user: USER }));
    const hash = params.get("hash")!;
    params.set("hash", (hash[0] === "0" ? "1" : "0") + hash.slice(1));
    expect(await validateInitData(params.toString(), TOKEN)).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("отклоняет некорректный формат hash", async () => {
    const params = new URLSearchParams(await signInitData(TOKEN, { user: USER }));
    params.set("hash", "zz");
    expect(await validateInitData(params.toString(), TOKEN)).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("отклоняет данные без hash", async () => {
    const params = new URLSearchParams(await signInitData(TOKEN, { user: USER }));
    params.delete("hash");
    expect(await validateInitData(params.toString(), TOKEN)).toEqual({ ok: false, reason: "missing_hash" });
    expect(await validateInitData("", TOKEN)).toEqual({ ok: false, reason: "missing_hash" });
  });

  it("отклоняет устаревший auth_date (старше 24 ч)", async () => {
    const initData = await signInitData(TOKEN, { user: USER, authDate: now() - 24 * 3600 - 5 });
    expect(await validateInitData(initData, TOKEN)).toEqual({ ok: false, reason: "expired" });
  });

  it("учитывает настраиваемый maxAgeSeconds", async () => {
    const initData = await signInitData(TOKEN, { user: USER, authDate: now() - 120 });
    expect((await validateInitData(initData, TOKEN)).ok).toBe(true);
    expect(await validateInitData(initData, TOKEN, { maxAgeSeconds: 60 })).toEqual({ ok: false, reason: "expired" });
  });

  it("отклоняет auth_date из будущего (> 60 с)", async () => {
    const future = await signInitData(TOKEN, { user: USER, authDate: now() + 300 });
    expect(await validateInitData(future, TOKEN)).toEqual({ ok: false, reason: "auth_date_in_future" });
    const slightSkew = await signInitData(TOKEN, { user: USER, authDate: now() + 30 });
    expect((await validateInitData(slightSkew, TOKEN)).ok).toBe(true);
  });

  it("отклоняет подписанные данные без user", async () => {
    const initData = await signInitData(TOKEN, {});
    expect(await validateInitData(initData, TOKEN)).toEqual({ ok: false, reason: "missing_user" });
  });

  it("отклоняет дубли ключей", async () => {
    const initData = await signInitData(TOKEN, { user: USER });
    expect(await validateInitData(`${initData}&auth_date=1`, TOKEN)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("buildDataCheckString", () => {
  it("сортирует поля, исключает hash и склеивает через \\n", () => {
    expect(
      buildDataCheckString([
        ["user", "{}"],
        ["hash", "abc"],
        ["auth_date", "1"],
        ["signature", "sig"],
      ]),
    ).toBe("auth_date=1\nsignature=sig\nuser={}");
  });
});
