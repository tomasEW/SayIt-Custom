import { fetch } from "@tauri-apps/plugin-http";
import type { ChatUsageData, EnhanceResult } from "../types/transcription";
import { DEFAULT_LLM_MODEL_ID } from "./modelRegistry";
import {
  buildFetchParams,
  parseProviderResponse,
  getProviderIdForModel,
  getProviderTimeout,
  getDefaultMaxTokens,
  type LlmChatRequest,
} from "./llmProvider";
import { getMinimalPromptForLocale } from "../i18n/prompts";
import type { SupportedLocale } from "../i18n/languageConfig";
import i18n from "../i18n";

const MAX_VOCABULARY_TERMS = 50;

export class EnhancerApiError extends Error {
  constructor(
    public statusCode: number,
    statusText: string,
    public body: string,
  ) {
    super(`Enhancement API error: ${statusCode} ${statusText}`);
    this.name = "EnhancerApiError";
  }
}

export class EnhancerEmptyResponseError extends Error {
  public code = "ENHANCEMENT_EMPTY_RESPONSE";

  constructor(message = "Enhancement returned empty content") {
    super(message);
    this.name = "EnhancerEmptyResponseError";
  }
}

export function getDefaultSystemPrompt(): string {
  return getMinimalPromptForLocale(i18n.global.locale.value as SupportedLocale);
}

export interface EnhanceOptions {
  systemPrompt?: string;
  vocabularyTermList?: string[];
  modelId?: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * 發送可真正取消的 LLM HTTP request。
 *
 * 舊版只用 Promise.race 做 timeout；計時器先 reject 後，底層 HTTP request 仍可能繼續跑。
 * 這裡使用獨立 AbortController，timeout 或外部取消都會真正 abort fetch。
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let didTimeout = false;

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, ms);

  const abortHandler = () => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (didTimeout) {
      const timeoutError = new Error("Enhancement timeout");
      (timeoutError as Error & { code: string }).code = "ENHANCEMENT_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", abortHandler);
  }
}

export function buildSystemPrompt(
  basePrompt: string,
  vocabularyTermList?: string[],
): string {
  let prompt = basePrompt;

  if (vocabularyTermList && vocabularyTermList.length > 0) {
    const truncatedTermList = vocabularyTermList.slice(0, MAX_VOCABULARY_TERMS);
    prompt += `\n\n<vocabulary>\n${truncatedTermList.join(", ")}\n</vocabulary>`;
  }

  return prompt;
}

/**
 * 移除 reasoning model（如 Qwen3）回應中的 <think>...</think> 區塊，
 * 只保留最終輸出內容。
 */
export function stripReasoningTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function enhanceText(
  rawText: string,
  apiKey: string,
  options?: EnhanceOptions,
): Promise<EnhanceResult> {
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("API Key not configured");
  }

  const modelId = options?.modelId ?? DEFAULT_LLM_MODEL_ID;
  const providerId = getProviderIdForModel(modelId);

  const basePrompt = options?.systemPrompt || getDefaultSystemPrompt();
  const fullPrompt = buildSystemPrompt(basePrompt, options?.vocabularyTermList);

  const request: LlmChatRequest = {
    model: modelId,
    messages: [
      { role: "system", content: fullPrompt },
      { role: "user", content: rawText },
    ],
    temperature: 0.1,
    maxTokens: options?.maxTokens ?? getDefaultMaxTokens(providerId),
  };

  const { url, init } = buildFetchParams(providerId, request, apiKey);

  const response = await fetchWithTimeout(
    url,
    init,
    getProviderTimeout(providerId),
    options?.signal,
  );

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    throw new EnhancerApiError(response.status, response.statusText, errorBody);
  }

  const json = await response.json();
  const result = parseProviderResponse(providerId, json);

  const usage: ChatUsageData | null = result.usage
    ? {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        promptTimeMs: result.usage.promptTimeMs,
        completionTimeMs: result.usage.completionTimeMs,
        totalTimeMs: result.usage.totalTimeMs,
      }
    : null;

  // 空回應不是「成功但剛好等於原文」。必須明確丟錯，讓上層記錄 wasEnhanced=false
  // 並顯示 unenhanced fallback，而不是把 raw transcript 偽裝成 AI 整理結果。
  if (!result.text) {
    throw new EnhancerEmptyResponseError();
  }

  const enhancedContent = stripReasoningTags(result.text);
  if (!enhancedContent) {
    throw new EnhancerEmptyResponseError(
      "Enhancement returned no content after removing reasoning tags",
    );
  }

  return { text: enhancedContent, usage };
}
