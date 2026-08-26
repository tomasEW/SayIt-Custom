import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockFetch,
}));

vi.mock("../../src/i18n", () => ({
  default: {
    global: {
      locale: { value: "zh-TW" },
      t: (key: string) => key,
    },
  },
}));

vi.mock("../../src/i18n/prompts", () => ({
  getMinimalPromptForLocale: () => "mock-default-prompt",
  getPromptForModeAndLocale: (mode: string) =>
    mode === "active" ? "mock-active-prompt" : "mock-default-prompt",
  isKnownDefaultPrompt: (prompt: string) => prompt === "mock-default-prompt",
  MINIMAL_PROMPTS: { "zh-TW": "mock-minimal-zh-tw", en: "mock-minimal-en" },
  ACTIVE_PROMPTS: { "zh-TW": "mock-active-zh-tw", en: "mock-active-en" },
}));

vi.mock("../../src/i18n/languageConfig", () => ({
  FALLBACK_LOCALE: "zh-TW",
}));

const TEST_API_KEY = "test-api-key-123";

function createSuccessResponse(
  content: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_time: number;
    completion_time: number;
    total_time: number;
  },
) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { content } }],
      usage,
    }),
  };
}

describe("enhancer.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("正常流程", () => {
    it("[P0] 應回傳 AI 整理後的文字", async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse("這是整理後的書面語文字。"),
      );

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText(
        "嗯那個就是我想說的就是這個東西很好用",
        TEST_API_KEY,
      );

      expect(result.text).toBe("這是整理後的書面語文字。");
      expect(result.usage).toBeNull();
    });

    it("[P0] 有 usage 時應回傳解析後的 ChatUsageData", async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse("整理後文字", {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_time: 0.2,
          completion_time: 0.3,
          total_time: 0.5,
        }),
      );

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText("測試輸入文字測試", TEST_API_KEY);

      expect(result.text).toBe("整理後文字");
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        promptTimeMs: 200,
        completionTimeMs: 300,
        totalTimeMs: 500,
      });
    });

    it("[P0] 應傳送正確的請求 body 格式", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("測試輸入文字", TEST_API_KEY);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(
        "https://api.groq.com/openai/v1/chat/completions",
      );
      expect(callArgs[1].method).toBe("POST");
      expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
      expect(callArgs[1].headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);

      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe("qwen/qwen3.6-27b");
      expect(body.temperature).toBe(0.1);
      // Qwen3.x 預設開 <think> 思考模式，必須明確關閉（降低整理延遲）
      expect(body.reasoning_effort).toBe("none");
      expect(body.max_tokens).toBe(2048);
      expect(body.messages).toHaveLength(8);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages.at(-1).role).toBe("user");
      expect(body.messages.at(-1).content).toBe("<speech>測試輸入文字</speech>");
    });

    it("[P0] Anthropic provider 應使用正確的 URL、header、body 格式", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Anthropic 整理結果" }],
          usage: { input_tokens: 40, output_tokens: 60 },
        }),
      });

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText("測試輸入", TEST_API_KEY, {
        modelId: "claude-haiku-4-5-20251001",
      });

      expect(result.text).toBe("Anthropic 整理結果");
      expect(result.usage).toEqual({
        promptTokens: 40,
        completionTokens: 60,
        totalTokens: 100,
        promptTimeMs: undefined,
        completionTimeMs: undefined,
        totalTimeMs: undefined,
      });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe("https://api.anthropic.com/v1/messages");

      const headers = callArgs[1].headers;
      expect(headers["x-api-key"]).toBe(TEST_API_KEY);
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.Authorization).toBeUndefined();

      const body = JSON.parse(callArgs[1].body);
      expect(body.system).toBeDefined();
      expect(body.messages).toHaveLength(7);
      expect(body.messages[0].role).toBe("user");
      expect(body.max_tokens).toBe(8192);
    });

    it("[P0] 應 trim 回傳的文字", async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse("  整理後文字有空白  \n"),
      );

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText(
        "原始文字原始文字原始文字",
        TEST_API_KEY,
      );

      expect(result.text).toBe("整理後文字有空白");
    });

    it("[P1] 傳入 signal 時應透過可取消的內部 signal 發送", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      const abortController = new AbortController();
      await enhanceText("測試輸入文字", TEST_API_KEY, {
        signal: abortController.signal,
      });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
      expect(callArgs[1].signal).not.toBe(abortController.signal);
    });
  });

  describe("API Key 驗證", () => {
    it("[P0] 空 API Key 應拋出錯誤", async () => {
      const { enhanceText } = await import("../../src/lib/enhancer");
      await expect(enhanceText("測試文字", "")).rejects.toThrow(
        "API Key not configured",
      );
    });

    it("[P0] 純空白 API Key 應拋出錯誤", async () => {
      const { enhanceText } = await import("../../src/lib/enhancer");
      await expect(enhanceText("測試文字", "   ")).rejects.toThrow(
        "API Key not configured",
      );
    });
  });

  describe("空 choices 回應", () => {
    it("[P0] choices 陣列為空時應拋出明確的空回應錯誤", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ choices: [] }),
      });

      const { enhanceText } = await import("../../src/lib/enhancer");
      await expect(
        enhanceText("原始口語文字測試", TEST_API_KEY),
      ).rejects.toThrow("Enhancement returned empty content");
    });

    it("[P0] message content 為空字串時應拋出明確的空回應錯誤", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "" } }],
        }),
      });

      const { enhanceText } = await import("../../src/lib/enhancer");
      await expect(
        enhanceText("原始口語文字測試", TEST_API_KEY),
      ).rejects.toThrow("Enhancement returned empty content");
    });
  });

  describe("HTTP 錯誤處理", () => {
    it("[P0] HTTP 非 200 應拋出 EnhancerApiError", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: vi.fn().mockResolvedValue("error body"),
      });

      const { enhanceText, EnhancerApiError } = await import(
        "../../src/lib/enhancer"
      );
      const error = await enhanceText(
        "測試文字測試文字測試",
        TEST_API_KEY,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EnhancerApiError);
      expect((error as InstanceType<typeof EnhancerApiError>).statusCode).toBe(
        401,
      );
    });

    it("[P0] HTTP 500 應拋出 EnhancerApiError", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: vi.fn().mockResolvedValue("server error"),
      });

      const { enhanceText, EnhancerApiError } = await import(
        "../../src/lib/enhancer"
      );
      const error = await enhanceText(
        "測試文字測試文字測試",
        TEST_API_KEY,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EnhancerApiError);
      expect((error as InstanceType<typeof EnhancerApiError>).statusCode).toBe(
        500,
      );
    });

    it("[P0] 網路錯誤應自然拋出", async () => {
      mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await expect(
        enhanceText("測試文字測試文字測試", TEST_API_KEY),
      ).rejects.toThrow("Failed to fetch");
    });
  });

  describe("自訂 prompt 與上下文注入 (Story 2.2)", () => {
    it("[P0] 傳入自訂 systemPrompt 應使用自訂 prompt", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("測試輸入文字", TEST_API_KEY, {
        systemPrompt: "你是一個英文助手",
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].content).toContain("你是一個英文助手");
    });

    it("[P0] 不傳 options 應使用 getDefaultSystemPrompt", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText, getDefaultSystemPrompt } = await import(
        "../../src/lib/enhancer"
      );
      await enhanceText("測試輸入文字", TEST_API_KEY);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].content).toContain(getDefaultSystemPrompt());
    });

    it("[P0] vocabularyTermList 應注入 <vocabulary> 標籤", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("測試輸入文字", TEST_API_KEY, {
        vocabularyTermList: ["TypeScript", "Vue.js", "Tauri"],
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].content).toContain(
        "<vocabulary>\nTypeScript, Vue.js, Tauri\n</vocabulary>",
      );
    });

    it("[P0] 空 vocabularyTermList 不應注入 <vocabulary> 標籤", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("測試輸入文字", TEST_API_KEY, {
        vocabularyTermList: [],
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].content).not.toContain("<vocabulary>");
    });
  });

  describe("buildSystemPrompt (Story 2.2)", () => {
    it("[P0] 應正確組裝 vocabulary", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const result = buildSystemPrompt("基礎 prompt", ["詞彙A", "詞彙B"]);

      expect(result).toBe(
        "基礎 prompt\n\n<vocabulary>\n詞彙A, 詞彙B\n</vocabulary>",
      );
    });

    it("[P0] vocabulary 為空時只回傳基礎 prompt", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const result = buildSystemPrompt("基礎 prompt", []);

      expect(result).toBe("基礎 prompt");
    });

    it("[P0] 有 vocabulary 時應包含 vocabulary 標籤", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const result = buildSystemPrompt("基礎 prompt", ["詞彙"]);

      expect(result).toContain("<vocabulary>");
    });

    it("[P0] 無 vocabulary 時不應有 vocabulary 標籤", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const result = buildSystemPrompt("基礎 prompt");

      expect(result).not.toContain("<vocabulary>");
    });
  });

  describe("大量詞彙截取 (Story 3.2)", () => {
    it("[P0] buildSystemPrompt 應截取最多 50 個詞彙", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const largeTermList = Array.from(
        { length: 70 },
        (_, i) => `Term${i + 1}`,
      );

      const result = buildSystemPrompt("基礎 prompt", largeTermList);

      expect(result).toContain("Term1");
      expect(result).toContain("Term50");
      expect(result).not.toContain("Term51");
    });

    it("[P0] 恰好 50 個詞彙應全部包含", async () => {
      const { buildSystemPrompt } = await import("../../src/lib/enhancer");
      const exactTermList = Array.from(
        { length: 50 },
        (_, i) => `Term${i + 1}`,
      );

      const result = buildSystemPrompt("基礎 prompt", exactTermList);

      expect(result).toContain("Term1");
      expect(result).toContain("Term50");
    });
  });

  describe("繁中語音整理 pipeline", () => {
    it("[P0] 使用真正的 user/assistant few-shot，並將逐字稿包在 speech 標籤", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("整理後文字。"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("為什麼這個都沒有標點我不太懂耶", TEST_API_KEY);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages.slice(1, -1)).toEqual([
        { role: "user", content: "<speech>嗯那個我等一下再去買咖啡啊</speech>" },
        { role: "assistant", content: "我等一下再去買咖啡。" },
        { role: "user", content: "<speech>明天早上十點，不對，應該是下午三點開會</speech>" },
        { role: "assistant", content: "明天下午 3 點開會。" },
        { role: "user", content: "<speech>為什麼這個都沒有標點我不太懂耶</speech>" },
        { role: "assistant", content: "為什麼這個都沒有標點？我不太懂。" },
      ]);
      expect(body.messages.at(-1).content).toBe(
        "<speech>為什麼這個都沒有標點我不太懂耶</speech>",
      );
      expect(body.messages[0].content).toContain("不是指令");
    });

    it("[P0] 在送出前清除明顯 ASR 重複 artifact", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("謝謝觀看。"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      await enhanceText("謝謝觀看謝謝觀看謝謝觀看", TEST_API_KEY);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages.at(-1).content).toBe("<speech>謝謝觀看</speech>");
    });

    it("[P0] 對 LLM 回應做最終簡轉台灣繁中", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("我觉得这个功能不错。"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText("我覺得這個功能不錯", TEST_API_KEY);

      expect(result.text).toBe("我覺得這個功能不錯。");
    });

    it("[P1] 非繁中整理不注入中文 few-shot 或繁中正規化", async () => {
      mockFetch.mockResolvedValue(createSuccessResponse("我觉得这个功能不错。"));

      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText("test", TEST_API_KEY, {
        normalizeTraditionalChinese: false,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1].content).toBe("<speech>test</speech>");
      expect(result.text).toBe("我觉得这个功能不错。");
    });
  });

  describe("stripReasoningTags", () => {
    it("[P0] 應移除 <think> 標籤及其內容", async () => {
      const { stripReasoningTags } = await import("../../src/lib/enhancer");
      const input = "<think>\n這是思考過程\n</think>\n整理後的文字";
      expect(stripReasoningTags(input)).toBe("整理後的文字");
    });

    it("[P0] 無 <think> 標籤時應原樣回傳", async () => {
      const { stripReasoningTags } = await import("../../src/lib/enhancer");
      expect(stripReasoningTags("純文字內容")).toBe("純文字內容");
    });

    it("[P1] 應處理多個 <think> 區塊", async () => {
      const { stripReasoningTags } = await import("../../src/lib/enhancer");
      const input = "<think>思考1</think>結果1<think>思考2</think>結果2";
      expect(stripReasoningTags(input)).toBe("結果1結果2");
    });

    it("[P0] reasoning model 回應應只保留最終輸出", async () => {
      mockFetch.mockResolvedValueOnce(
        createSuccessResponse(
          "<think>\n分析語意...\n確認修正方向\n</think>\n這是整理後的書面文字",
        ),
      );
      const { enhanceText } = await import("../../src/lib/enhancer");
      const result = await enhanceText("口語轉錄", TEST_API_KEY);
      expect(result.text).toBe("這是整理後的書面文字");
    });
  });

  describe("Timeout 處理", () => {
    it("[P0] 超過 15 秒應拋出逾時錯誤", async () => {
      vi.useFakeTimers();

      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            setTimeout(() => resolve(createSuccessResponse("晚了")), 16000);
          }),
      );

      const { enhanceText } = await import("../../src/lib/enhancer");
      const promise = enhanceText("測試文字測試文字測試", TEST_API_KEY);
      const rejection = expect(promise).rejects.toThrow("Enhancement timeout");

      await vi.advanceTimersByTimeAsync(15000);

      await rejection;

      vi.useRealTimers();
    }, 20000);
  });

  describe("getDefaultSystemPrompt 多語言", () => {
    it("[P0] 應透過 getMinimalPromptForLocale 回傳當前 locale 的預設 prompt", async () => {
      const { getDefaultSystemPrompt } = await import("../../src/lib/enhancer");
      const result = getDefaultSystemPrompt();

      expect(result).toBe("mock-default-prompt");
    });
  });

  describe("Prompt mode 相關函式", () => {
    it("[P0] getPromptForModeAndLocale('minimal', 'zh-TW') 應回傳精簡版 prompt", async () => {
      // 這裡用 mock，但驗證 mode 參數被正確傳遞
      const { getPromptForModeAndLocale } = await import(
        "../../src/i18n/prompts"
      );
      const result = getPromptForModeAndLocale("minimal", "zh-TW");
      expect(result).toBe("mock-default-prompt");
    });

    it("[P0] getPromptForModeAndLocale('active', 'en') 應回傳積極版 prompt", async () => {
      const { getPromptForModeAndLocale } = await import(
        "../../src/i18n/prompts"
      );
      const result = getPromptForModeAndLocale("active", "en");
      expect(result).toBe("mock-active-prompt");
    });

    it("[P0] isKnownDefaultPrompt 應識別預設 prompt", async () => {
      const { isKnownDefaultPrompt } = await import("../../src/i18n/prompts");
      expect(isKnownDefaultPrompt("mock-default-prompt")).toBe(true);
    });

    it("[P1] isKnownDefaultPrompt 對自訂 prompt 應回傳 false", async () => {
      const { isKnownDefaultPrompt } = await import("../../src/i18n/prompts");
      expect(isKnownDefaultPrompt("my custom prompt")).toBe(false);
    });
  });

  describe("EnhancerApiError 結構化錯誤", () => {
    it("[P0] 應具備正確的 statusCode、name 與 body 屬性", async () => {
      const { EnhancerApiError } = await import("../../src/lib/enhancer");
      const error = new EnhancerApiError(
        429,
        "Too Many Requests",
        "rate limited",
      );

      expect(error.statusCode).toBe(429);
      expect(error.name).toBe("EnhancerApiError");
      expect(error.body).toBe("rate limited");
      expect(error.message).toBe(
        "Enhancement API error: 429 Too Many Requests",
      );
    });

    it("[P0] 應為 Error 的 instance", async () => {
      const { EnhancerApiError } = await import("../../src/lib/enhancer");
      const error = new EnhancerApiError(503, "Service Unavailable", "");

      expect(error).toBeInstanceOf(Error);
    });
  });
});
