export const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
export const DEEPSEEK_WEB_API = `${DEEPSEEK_WEB_BASE}/api`;

export const DEEPSEEK_WEB_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: DEEPSEEK_WEB_BASE,
  Referer: `${DEEPSEEK_WEB_BASE}/`,
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "X-Client-Bundle-Id": "com.deepseek.chat",
  "X-Client-Locale": "zh_CN",
  "X-Client-Platform": "web",
  "X-Client-Version": "2.0.0",
};

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after?: number;
  target_path: string;
}

export interface WebCompletionResult {
  content: string;
  reasoning: string;
}
