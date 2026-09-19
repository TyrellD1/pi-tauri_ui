// pi-tauri_ui — boundary between UI code and the Tauri RPC layer.
//
// Production path: thin re-exports of the real @tauri-apps/api fns.
// Development path: a dev-only bridge (loaded dynamically, only when
// `import.meta.env.DEV` and `?dev=1`) can register a fake via
// setTauriOverride(). Mocks never enter the production bundle because the
// bridge module is only ever reached through a dead-in-prod dynamic import.

import { invoke as realInvoke } from "@tauri-apps/api/core";
import { listen as realListen } from "@tauri-apps/api/event";

export interface TauriOverride {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: (event: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void>;
}

let override: TauriOverride | null = null;

export function setTauriOverride(o: TauriOverride | null): void {
  override = o;
}

export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (override?.invoke) return override.invoke(cmd, args) as Promise<T>;
  return realInvoke(cmd, args ?? {}) as Promise<T>;
}

export function listen<T>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> {
  if (override?.listen) return override.listen(event, cb as (ev: { payload: unknown }) => void);
  return realListen(event, cb);
}
