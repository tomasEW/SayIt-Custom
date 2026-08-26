/**
 * 簡體 → 繁體（台灣）轉換 — 純函式，供轉錄結果落地前套用。
 *
 * 背景（#39）：Whisper 對中文預設輸出簡體，而使用者若選繁中，會期待繁體輸出。
 * SayIt 過去沒有確定性的簡→繁轉換（只靠 AI 整理偶爾順手轉、不穩定）。
 * 這裡用 opencc-js 做字元級（Taiwan 標準）轉換，只在轉譯語言解析為 zh-TW 時套用。
 *
 * 使用 `to: "twp"`，讓 LLM 在整理後新生成的簡體詞彙也能確定收斂成台灣繁中。
 */
import { Converter } from "opencc-js";

let convert: ((text: string) => string) | null = null;

/** 惰性建立 converter（載入字典有成本，建立一次即可重用）。 */
function getConverter(): (text: string) => string {
  if (!convert) {
    convert = Converter({ from: "cn", to: "twp" });
  }
  return convert;
}

/** 把簡體中文轉成繁體（台灣）。空字串原樣返回。 */
export function convertSimplifiedToTraditional(text: string): string {
  if (!text) return text;
  return getConverter()(text);
}
