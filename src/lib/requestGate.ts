import type { AppSettings } from "../types";
import { isWebTransport } from "./settings";

type GateJob<T = unknown> = {
  settings: AppSettings;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

const queue: GateJob[] = [];
let active = 0;
let lastStartAt = 0;
let pumping = false;

function maxConcurrency(settings: AppSettings): number {
  return isWebTransport(settings) ? 1 : 2;
}

function minIntervalMs(settings: AppSettings): number {
  if (!isWebTransport(settings)) return 0;
  const n = Number(settings.webMinIntervalMs);
  if (Number.isNaN(n) || n < 0) return 3000;
  return Math.min(60000, Math.round(n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const next = queue[0];
      if (!next) break;
      const limit = maxConcurrency(next.settings);
      if (active >= limit) break;

      queue.shift();
      const gap = minIntervalMs(next.settings);
      if (gap > 0) {
        const wait = gap - (Date.now() - lastStartAt);
        if (wait > 0) await sleep(wait);
      }
      lastStartAt = Date.now();
      active += 1;
      void next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          void pump();
        });
    }
  } finally {
    pumping = false;
  }
}

/** Serialize / throttle network completions (esp. DeepSeek web session). */
export function withRequestGate<T>(
  settings: AppSettings,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      settings,
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    void pump();
  });
}
