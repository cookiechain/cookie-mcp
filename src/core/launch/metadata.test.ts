import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";

import { uploadMetadata } from "./metadata";
import { CookieMcpError } from "../errors";

// The image-argument guards run before any network call, so they can be asserted without mocking
// fetch. The happy path (base64 → body.image, url → body.imageUrl) is covered by the live launch test.
describe("uploadMetadata image guards", () => {
  const kp = Keypair.generate();
  const base = { mint: kp.publicKey.toBase58(), name: "T", symbol: "T" };

  it("rejects supplying both image bytes and an image URL", async () => {
    await expect(
      uploadMetadata(kp, {
        ...base,
        imageBase64: "aGVsbG8=",
        imageMimeType: "image/png",
        imageUrl: "https://x/y.png",
      }),
    ).rejects.toBeInstanceOf(CookieMcpError);
  });

  it("rejects image bytes without a MIME type", async () => {
    await expect(uploadMetadata(kp, { ...base, imageBase64: "aGVsbG8=" })).rejects.toBeInstanceOf(
      CookieMcpError,
    );
  });
});
