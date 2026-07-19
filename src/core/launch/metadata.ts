// Upload DBC token metadata to Cookiebox's metadata API and return the Metaplex `uri` for the launch
// tx. The API authorizes the upload with an ed25519 signature over a fixed message (a message
// signature — moves no funds). The image can be supplied two ways: raw bytes (base64 + mimeType,
// what an image-generating agent produces) or an already-hosted https URL — not both.
import type { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

import { CookieMcpError } from "../errors";

const UPLOAD_URL = "https://api.cookiebox.app/api/bonding/upload-metadata";

export interface UploadMetadataResult {
  uri: string;
  imageUrl: string;
}

export async function uploadMetadata(
  keypair: Keypair,
  params: {
    mint: string;
    name: string;
    symbol: string;
    description?: string;
    imageUrl?: string;
    imageBase64?: string;
    imageMimeType?: string;
  },
): Promise<UploadMetadataResult> {
  const hasBytes = !!params.imageBase64?.trim();
  const hasUrl = !!params.imageUrl?.trim();
  if (hasBytes && hasUrl) {
    throw new CookieMcpError(
      "provide either image bytes or an image URL, not both",
      "pass imageBase64 (+ imageMimeType) for a generated logo, OR imageUrl for a hosted one",
    );
  }
  if (hasBytes && !params.imageMimeType?.trim()) {
    throw new CookieMcpError(
      "imageMimeType is required when passing imageBase64",
      'set the image MIME type, e.g. "image/png" or "image/jpeg"',
    );
  }

  const timestamp = Date.now();
  const message = new TextEncoder().encode(
    `Token metadata upload.\n\n` +
      `This signature does not move funds or approve any transaction.\n\n` +
      `Timestamp: ${timestamp}`,
  );
  const sig = ed25519.sign(message, keypair.secretKey.slice(0, 32));

  const body: Record<string, unknown> = {
    mint: params.mint,
    name: params.name.trim(),
    symbol: params.symbol.trim().toUpperCase(),
    description: (params.description ?? "").trim(),
    wallet: Buffer.from(keypair.publicKey.toBytes()).toString("base64"),
    signature: Buffer.from(sig).toString("base64"),
    timestamp,
  };
  if (hasBytes) {
    // Strip a data-URI prefix if the agent passed one (e.g. "data:image/png;base64,....").
    const raw = params.imageBase64!.trim();
    body.image = raw.replace(/^data:[^;]+;base64,/, "");
    body.mimeType = params.imageMimeType!.trim();
  } else if (hasUrl) {
    body.imageUrl = params.imageUrl!.trim();
  }

  let res: Response;
  try {
    res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CookieMcpError(
      "could not reach the metadata upload API",
      "check connectivity to api.cookiebox.app and retry",
    );
  }

  const text = await res.text();
  let data: { error?: string; reason?: string; uri?: string; imageUrl?: string } = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new CookieMcpError(
        `metadata upload returned invalid JSON (HTTP ${res.status})`,
        "the upload API may be down; retry shortly",
      );
    }
  }
  if (!res.ok || !data.uri || !data.imageUrl) {
    throw new CookieMcpError(
      data.error ?? `metadata upload failed (HTTP ${res.status})`,
      data.reason ??
        "provide a logo — imageBase64 (+ imageMimeType) or a valid https `imageUrl`; check name/symbol and retry",
    );
  }
  return { uri: data.uri, imageUrl: data.imageUrl };
}
