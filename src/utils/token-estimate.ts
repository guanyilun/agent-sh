export const IMAGE_TOKENS = 1600;

export function estimateMessagesTokens(messages: readonly unknown[]): number {
  let images = 0;
  const json = JSON.stringify(messages, (key, value) => {
    if (key === "meta") return undefined;
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "image_url") {
      images++;
      return null;
    }
    return value;
  });
  return Math.ceil((json?.length ?? 0) / 4) + images * IMAGE_TOKENS;
}
