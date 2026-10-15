import {providerFetch,AccessError} from "./access";
export async function fetchRetry(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    // Keep the timeout alive while callers consume the body, not just until headers arrive.
    const timeout=AbortSignal.timeout(15000);
    const signal=init?.signal?AbortSignal.any([init.signal,timeout]):timeout;
    try {
      const res = await providerFetch(url, { ...init, signal });
      return res;
    } catch (error) {
      if (error instanceof AccessError && error.kind==="unavailable" && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error("fetchRetry exhausted");
}
