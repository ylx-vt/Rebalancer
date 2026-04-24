import type { ImportParser, ImportResult } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeCode = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim();
  return code.length > 0 ? code : null;
};

export const fundAssistantParser: ImportParser = {
  formatName: "自选基金助手",
  canParse(raw) {
    return isRecord(raw) && Array.isArray(raw.fundListGroup);
  },
  extractCodes(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.fundListGroup)) {
      return [];
    }

    return raw.fundListGroup.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.funds)) {
        return [];
      }
      return group.funds
        .map((fund) => (isRecord(fund) ? normalizeCode(fund.code) : null))
        .filter((code): code is string => code !== null);
    });
  }
};

export const plainCodeArrayParser: ImportParser = {
  formatName: "代码数组",
  canParse(raw) {
    return Array.isArray(raw);
  },
  extractCodes(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => {
        if (typeof item === "string") {
          return normalizeCode(item);
        }
        if (isRecord(item)) {
          return normalizeCode(item.code);
        }
        return null;
      })
      .filter((code): code is string => code !== null);
  }
};

export const importParsers: ImportParser[] = [fundAssistantParser, plainCodeArrayParser];

export const parseFundImport = (text: string, parsers = importParsers): ImportResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON 解析失败");
  }

  const parser = parsers.find((candidate) => candidate.canParse(raw));
  if (!parser) {
    throw new Error("暂不支持该 JSON 格式");
  }

  const extracted = parser.extractCodes(raw);
  const uniqueCodes = Array.from(new Set(extracted.map((code) => code.trim()).filter(Boolean)));

  if (uniqueCodes.length === 0) {
    throw new Error("JSON 中未找到有效基金代码");
  }

  return {
    codes: uniqueCodes,
    parserName: parser.formatName,
    skippedCount: Math.max(0, extracted.length - uniqueCodes.length)
  };
};
