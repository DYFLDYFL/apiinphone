import { Capacitor, registerPlugin } from "@capacitor/core";

interface PythonSandboxPlugin {
  run(options: { code: string; timeoutSec: number }): Promise<{ output: string }>;
}

const PythonSandbox = registerPlugin<PythonSandboxPlugin>("PythonSandbox");

export function isNativePythonAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function runNativePython(
  code: string,
  timeoutSec: number,
): Promise<string> {
  const result = await PythonSandbox.run({ code, timeoutSec });
  return result.output ?? "(无输出)";
}
