import { meResponseSchema, type MeResponse } from "../../../shared/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`);
  }
}

async function apiGet(path: string, initData: string): Promise<unknown> {
  const res = await fetch(path, { headers: { Authorization: `tma ${initData}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(res.status, typeof body?.error === "string" ? body.error : "unknown");
  }
  return res.json();
}

export async function fetchMe(initData: string): Promise<MeResponse> {
  return meResponseSchema.parse(await apiGet("/api/me", initData));
}
