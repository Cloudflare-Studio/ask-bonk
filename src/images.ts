import type { ImageData } from "./types";
import { Result } from "better-result";
import { log } from "./log";

// Retry config for file downloads: 3 attempts with exponential backoff starting at 5s.
const RETRY_CONFIG = {
  times: 3,
  delayMs: 5000,
  backoff: "exponential" as const,
};

// Extracts GitHub user-attachments (images/files) from comment markdown
// and converts them to base64 for the AI prompt
export async function extractImages(
  body: string,
  accessToken: string,
): Promise<{ processedBody: string; images: ImageData[] }> {
  const images: ImageData[] = [];
  const mdMatches = [
    ...body.matchAll(/!?\[.*?\]\((https:\/\/github\.com\/user-attachments\/[^)]+)\)/gi),
  ];
  const tagMatches = [
    ...body.matchAll(/<img .*?src="(https:\/\/github\.com\/user-attachments\/[^"]+)" \/>/gi),
  ];

  const matches = [...mdMatches, ...tagMatches].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (matches.length === 0) {
    return { processedBody: body, images: [] };
  }

  let processedBody = body;
  let offset = 0;

  for (const match of matches) {
    const tag = match[0];
    const url = match[1];
    const start = match.index ?? 0;

    if (!url) continue;

    const filename = getFilename(url);
    const fileData = await downloadFile(url, accessToken);
    if (!fileData) {
      // Error already logged in downloadFile with exception details
      continue;
    }

    const replacement = `@${filename}`;
    processedBody =
      processedBody.slice(0, start + offset) +
      replacement +
      processedBody.slice(start + offset + tag.length);

    images.push({
      filename,
      mime: fileData.mime,
      content: fileData.content,
      start: start + offset,
      end: start + offset + replacement.length,
      replacement,
    });

    offset += replacement.length - tag.length;
  }

  return { processedBody, images };
}

function getFilename(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1] || "file";
}

async function downloadFile(
  url: string,
  accessToken: string,
): Promise<{ mime: string; content: string } | null> {
  const result = await Result.tryPromise(
    async () => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mime = contentType.startsWith("image/") ? contentType : "text/plain";

      return { mime, content: base64 };
    },
    { retry: RETRY_CONFIG },
  );

  if (result.isErr()) {
    log.errorWithException("file_download_error", result.error, { url });
    return null;
  }
  return result.value;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function imagesToPromptParts(images: ImageData[]): Array<{
  type: "file";
  mime: string;
  url: string;
  filename: string;
  source: {
    type: "file";
    text: { value: string; start: number; end: number };
    path: string;
  };
}> {
  return images.map((img) => ({
    type: "file" as const,
    mime: img.mime,
    url: `data:${img.mime};base64,${img.content}`,
    filename: img.filename,
    source: {
      type: "file" as const,
      text: {
        value: img.replacement,
        start: img.start,
        end: img.end,
      },
      path: img.filename,
    },
  }));
}
