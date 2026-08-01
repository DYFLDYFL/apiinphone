/** DeepSeekHashV1 PoW via vendored sha3 wasm (from deepseek4free). */

type WasmExports = {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    ptr0: number,
    len0: number,
    ptr1: number,
    len1: number,
    difficulty: number,
  ) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export_0: (size: number, align: number) => number;
  __wbindgen_export_1: (
    ptr: number,
    oldSize: number,
    newSize: number,
    align: number,
  ) => number;
};

let wasmExports: WasmExports | null = null;
let initPromise: Promise<WasmExports> | null = null;

async function loadWasm(): Promise<WasmExports> {
  if (wasmExports) return wasmExports;
  if (!initPromise) {
    initPromise = (async () => {
      const url = `${import.meta.env.BASE_URL}deepseek_pow.wasm`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`无法加载 PoW WASM (${resp.status})`);
      }
      const buffer = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(buffer, { wbg: {} });
      wasmExports = instance.exports as unknown as WasmExports;
      return wasmExports;
    })();
  }
  return initPromise;
}

class DeepSeekHashWasm {
  private offset = 0;
  private cachedUint8: Uint8Array | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly wasm: WasmExports) {}

  private mem(): Uint8Array {
    if (!this.cachedUint8?.byteLength) {
      this.cachedUint8 = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.cachedUint8;
  }

  private encodeString(text: string): number {
    const strLength = text.length;
    let ptr = this.wasm.__wbindgen_export_0(strLength, 1) >>> 0;
    this.cachedUint8 = null;
    const memory = this.mem();
    let asciiLength = 0;
    for (; asciiLength < strLength; asciiLength++) {
      if (text.charCodeAt(asciiLength) > 127) break;
      memory[ptr + asciiLength] = text.charCodeAt(asciiLength);
    }
    if (asciiLength !== strLength) {
      let rest = text;
      if (asciiLength > 0) rest = text.slice(asciiLength);
      ptr =
        this.wasm.__wbindgen_export_1(
          ptr,
          strLength,
          asciiLength + rest.length * 3,
          1,
        ) >>> 0;
      this.cachedUint8 = null;
      const result = this.encoder.encodeInto(
        rest,
        this.mem().subarray(
          ptr + asciiLength,
          ptr + asciiLength + rest.length * 3,
        ),
      );
      asciiLength += result.written ?? 0;
      ptr =
        this.wasm.__wbindgen_export_1(
          ptr,
          asciiLength + rest.length * 3,
          asciiLength,
          1,
        ) >>> 0;
      this.cachedUint8 = null;
    }
    this.offset = asciiLength;
    return ptr;
  }

  calculateHash(
    challenge: string,
    prefix: string,
    difficulty: number,
  ): number | undefined {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr0 = this.encodeString(challenge);
      const len0 = this.offset;
      const ptr1 = this.encodeString(prefix);
      const len1 = this.offset;
      this.wasm.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);
      const dv = new DataView(this.wasm.memory.buffer);
      const status = dv.getInt32(retptr + 0, true);
      const value = dv.getFloat64(retptr + 8, true);
      return status === 0 ? undefined : value;
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
}

export async function solvePowChallenge(config: {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}): Promise<string> {
  if (config.algorithm !== "DeepSeekHashV1") {
    throw new Error(`不支持的 PoW 算法：${config.algorithm}`);
  }
  const wasm = await loadWasm();
  const hasher = new DeepSeekHashWasm(wasm);
  const prefix = `${config.salt}_${config.expire_at}_`;
  const answer = hasher.calculateHash(
    config.challenge,
    prefix,
    config.difficulty,
  );
  if (answer == null || Number.isNaN(answer)) {
    throw new Error("PoW 求解失败，请稍后重试或更新 Cookie");
  }
  const payload = {
    algorithm: config.algorithm,
    challenge: config.challenge,
    salt: config.salt,
    answer,
    signature: config.signature,
    target_path: config.target_path,
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
