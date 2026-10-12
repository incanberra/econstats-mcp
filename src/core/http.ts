import {providerFetch,AccessError} from "./access";
export async function fetchRetry(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await providerFetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof AccessError && error.kind==="unavailable" && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error("fetchRetry exhausted");
}
