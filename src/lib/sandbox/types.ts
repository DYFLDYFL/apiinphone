export class SandboxError extends Error {}

export interface SandboxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: unknown;
  error?: string;
  timedOut?: boolean;
}
