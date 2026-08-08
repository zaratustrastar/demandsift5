import type { StorageProvider, StoredObject } from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";

type StoredBytes = StoredObject & { bytes: Uint8Array };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateKey(key: string) {
  const hasControlCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!key || key.length > 1_024 || hasControlCharacter) {
    throw new Error("Storage key is invalid.");
  }
}

function validateContentType(contentType: string) {
  if (
    !contentType ||
    contentType.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/i.test(contentType)
  ) {
    throw new Error("Storage content type is invalid.");
  }
}

async function readBounded(
  body: Uint8Array | ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error("Storage object exceeds the local size limit.");
    return body.slice();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Storage object exceeded the local size limit.");
        throw new Error("Storage object exceeds the local size limit.");
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Development-only, process-local object storage with defensive copies. */
export class InMemoryStorageProvider implements StorageProvider {
  readonly name = "memory-storage";
  private readonly objects = new Map<string, StoredBytes>();

  constructor(private readonly maxObjectBytes = 5_000_000) {
    if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 100_000_000) {
      throw new Error("Storage size limit is invalid.");
    }
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType: string,
  ): Promise<StoredObject> {
    validateKey(key);
    validateContentType(contentType);
    const bytes = await readBounded(body, this.maxObjectBytes);
    const stored: StoredBytes = {
      key,
      etag: await sha256Hex(bytes),
      size: bytes.byteLength,
      contentType,
      bytes,
    };
    this.objects.set(key, stored);
    return {
      key: stored.key,
      etag: stored.etag,
      size: stored.size,
      contentType: stored.contentType,
    };
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    validateKey(key);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    this.objects.delete(key);
  }
}

const localStorageProvider = new InMemoryStorageProvider();

export function createStorageProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  registered: Readonly<Record<string, StorageProvider>> = {},
): StorageProvider {
  const configured = env.STORAGE_PROVIDER?.trim().toLocaleLowerCase("en-US");
  const selected = configured || (isProductionRuntime(env) ? "" : "local");
  if (!selected) {
    throw new Error("STORAGE_PROVIDER must select a configured production storage provider.");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(selected)) {
    throw new Error("STORAGE_PROVIDER contains an unsupported provider name.");
  }
  if (selected === "local" || selected === "memory") {
    if (isProductionRuntime(env)) {
      throw new Error("The in-memory storage provider is disabled in production.");
    }
    return localStorageProvider;
  }
  const provider = registered[selected];
  if (!provider) {
    throw new Error("STORAGE_PROVIDER does not identify a registered storage provider.");
  }
  return provider;
}
