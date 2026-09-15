/**
 * `POST /api/cli` ラッパ（docs/06 §1.1, §3.3）。
 * Web の状態変更はすべてここを通り、CLI コマンドの発行として実行される。
 * 409 `E_CONFIRM_REQUIRED` を受けたら確認ダイアログを出し、`confirm: true` で再送する。
 */
import { refreshAssets, refreshHistory, refreshProject, refreshStatus } from "./api.ts";
import { useStore } from "./store.ts";

export interface CliError {
  code: string;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export interface CliResponse {
  ok: boolean;
  command?: string;
  result?: unknown;
  error?: CliError;
  exec?: { args: string[]; duration_ms: number; exit_code: number | null };
  [k: string]: unknown;
}

export interface ExecOptions {
  confirm?: boolean;
  /** 確認ダイアログ（既定: window.confirm）。テストで差し替える */
  ask?: (text: string) => boolean | Promise<boolean>;
  /** true ならトーストを出さない */
  silent?: boolean;
}

export async function execCli(args: string[], opts: ExecOptions = {}): Promise<CliResponse> {
  const res = await fetch("/api/cli", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args, confirm: opts.confirm === true }),
  });
  let body: CliResponse;
  try {
    body = (await res.json()) as CliResponse;
  } catch {
    body = { ok: false, error: { code: "E_BAD_RESPONSE", message: `HTTP ${res.status}` } };
  }

  if (res.status === 409 && body.error?.code === "E_CONFIRM_REQUIRED" && opts.confirm !== true) {
    const ask = opts.ask ?? ((t: string) => window.confirm(t));
    const yes = await ask(`This runs a destructive command:\n\n  montash ${args.join(" ")}\n\nContinue?`);
    if (!yes) return { ok: false, error: { code: "E_CANCELLED", message: "cancelled by user" } };
    return execCli(args, { ...opts, confirm: true });
  }

  if (!opts.silent) {
    const st = useStore.getState();
    const cmd = `montash ${args.join(" ")}`;
    if (body.ok) {
      st.toast("info", `${cmd} — ok${body.exec ? ` (${body.exec.duration_ms}ms)` : ""}`);
      st.log("info", `${cmd} → ok`, "web");
    } else {
      const e = body.error;
      st.toast("error", `${cmd} — ${e?.code ?? "error"}: ${e?.message ?? ""}${e?.hint ? `\n${e.hint}` : ""}`);
      st.log("error", `${cmd} → ${e?.code ?? "error"}: ${e?.message ?? ""}`, "web");
    }
  }
  if (body.ok) await Promise.all([refreshProject(), refreshHistory(), refreshStatus(), refreshAssets()]);
  return body;
}

export const undo = (): Promise<CliResponse> => execCli(["undo"]);
export const redo = (): Promise<CliResponse> => execCli(["redo"]);
export const checkout = (ref: string): Promise<CliResponse> => execCli(["checkout", ref]);

/** `POST /api/upload` の戻り（CLI の import 結果 + 保存情報） */
export interface UploadResponse extends CliResponse {
  upload?: { path: string; relative: string; size: number; original_name: string };
}

/**
 * ファイルをアップロードして `import <保存パス> --proxy` まで走らせる（docs/06 §3.3）。
 * 進捗は WS の `job.progress` / `job.done` で届く。
 */
export async function uploadAsset(file: File, opts: { silent?: boolean } = {}): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  let body: UploadResponse;
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    body = (await res.json()) as UploadResponse;
  } catch (error) {
    body = { ok: false, error: { code: "E_BAD_RESPONSE", message: String(error) } };
  }
  if (!opts.silent) {
    const st = useStore.getState();
    if (body.ok) {
      st.toast("info", `${file.name} を取り込みました`);
      st.log("info", `upload ${file.name} → import ok`, "web");
    } else {
      const e = body.error;
      st.toast("error", `${file.name} — ${e?.code ?? "error"}: ${e?.message ?? ""}${e?.hint ? `\n${e.hint}` : ""}`);
      st.log("error", `upload ${file.name} → ${e?.code ?? "error"}: ${e?.message ?? ""}`, "web");
    }
  }
  if (body.ok) await Promise.all([refreshProject(), refreshHistory(), refreshStatus(), refreshAssets()]);
  return body;
}
