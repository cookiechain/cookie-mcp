// A drop's artwork, read from a folder on this machine — the shapes the MomoSwap launch wizard takes:
//
//   1. images and nothing else — `1.png … 1000.png`: no names, no traits;
//   2. images with a Metaplex-style JSON beside each — `1.png` + `1.json` (`name`, `attributes`).
//
// Matching is by file stem, case-insensitive. The order is natural (`2` before `10`): it is the order
// sealed into the fairness commitment, so it has to be stable, but it carries no meaning — minting is
// shuffled by the committed reveal.
//
// Same confinement as a `deploy_token` logo (imageFile.ts): local-user only, inside the image
// directory, no hidden segments. Images are listed here and read one at a time while uploading, so a
// 10,000-piece drop is never held in memory.
import fs from "node:fs";
import path from "node:path";

import { CookieMcpError } from "../errors";
import {
  assertLocalFilesAllowed,
  imageRoot,
  isAllowedImagePath,
  resolveImagePath,
  sniffImageMimeType,
} from "../imageFile";
import { MAX_DROP_SUPPLY, MIN_DROP_SUPPLY } from "./curve";

/** Per piece, as the launchpad's `/v1/nft/art` takes it. */
export const MAX_ART_BYTES = 25_000_000;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
/** The launchpad keeps at most this many traits per piece, each up to 64 characters. */
const MAX_TRAITS = 32;
const MAX_TRAIT_LEN = 64;

export interface Attribute {
  trait_type: string;
  value: string;
}

export interface ArtPiece {
  /** Real path, already confined to the image directory. */
  file: string;
  fileName: string;
  bytes: number;
  /** From the JSON beside it; the chain names items `{collection} #{n}` regardless. */
  name: string | null;
  attributes: Attribute[];
}

export interface ArtSet {
  pieces: ArtPiece[];
  totalBytes: number;
  /** Pieces that had a JSON beside them. */
  withMetadata: number;
  /** Everything worth telling the user that did not stop the launch. */
  warnings: string[];
}

const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
/** `2` before `10`, `ape-9` before `ape-10`. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

export const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim().toLowerCase();
};

const extOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

const asValue = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * One piece's metadata (pure): Metaplex `{ name, attributes: [{trait_type, value}] }`, or a flat
 * `traits: { Background: "Blue" }` object. Long traits are cut to what the launchpad keeps.
 */
export function readPieceMeta(raw: unknown): { name: string | null; attributes: Attribute[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const src = o.attributes ?? o.traits;
  const out: Attribute[] = [];
  const push = (t: unknown, v: unknown) => {
    const tt = asValue(t);
    const vv = asValue(v);
    if (tt && vv)
      out.push({ trait_type: tt.slice(0, MAX_TRAIT_LEN), value: vv.slice(0, MAX_TRAIT_LEN) });
  };
  if (Array.isArray(src)) {
    for (const a of src)
      push((a as { trait_type?: unknown })?.trait_type, (a as { value?: unknown })?.value);
  } else if (src && typeof src === "object") {
    for (const [t, v] of Object.entries(src as Record<string, unknown>)) push(t, v);
  }
  const name = asValue(o.name);
  return { name: name ? name.slice(0, 64) : null, attributes: out.slice(0, MAX_TRAITS) };
}

/**
 * Confine a user-supplied path to the image directory, or throw one message for every failure. The
 * art folder may be the image directory itself (`COOKIE_IMAGE_DIR` pointed straight at it): its
 * entries are then direct children, and hidden ones are skipped when it is listed.
 */
function confined(input: string, root: string, what: string, rootAllowed = false): string {
  const unusable = () =>
    new CookieMcpError(
      `cannot use "${input.trim()}" as ${what}: not readable under the image directory`,
      `it must sit inside ${process.env.COOKIE_IMAGE_DIR?.trim() ? "COOKIE_IMAGE_DIR" : "your home directory"} ` +
        "with no hidden folder in the path; set COOKIE_IMAGE_DIR to read from elsewhere",
    );
  let real: string;
  try {
    real = fs.realpathSync(resolveImagePath(input));
  } catch {
    throw unusable();
  }
  if (!(rootAllowed && real === root) && !isAllowedImagePath(real, root)) throw unusable();
  return real;
}

/** List a drop's art folder (no image bytes are read beyond a format check). */
export function readArtDir(input: string): ArtSet {
  assertLocalFilesAllowed();
  const root = imageRoot();
  const dir = confined(input, root, "the art folder", true);
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new CookieMcpError(
      `"${input.trim()}" is not a readable folder`,
      "artDir must be a folder of PNG/JPEG/GIF/WebP images (optionally with a .json per image)",
    );
  }

  const warnings: string[] = [];
  const json = new Map<string, string>();
  const images: fs.Dirent[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const ext = extOf(e.name);
    if (ext === "json") json.set(stemOf(e.name), e.name);
    else if (IMAGE_EXT.has(ext)) images.push(e);
    else skipped.push(e.name);
  }
  if (skipped.length) {
    warnings.push(
      `${skipped.length} file(s) skipped as not mintable art (PNG/JPEG/GIF/WebP only): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`,
    );
  }
  images.sort((a, b) => naturalCompare(a.name, b.name));

  const seen = new Map<string, string>();
  const pieces: ArtPiece[] = [];
  let totalBytes = 0;
  let withMetadata = 0;
  for (const e of images) {
    const stem = stemOf(e.name);
    const clash = seen.get(stem);
    if (clash) {
      throw new CookieMcpError(
        `two images share the name "${stem}" (${clash} and ${e.name})`,
        "each piece is matched to its metadata by file name, so names must be unique — rename one",
      );
    }
    seen.set(stem, e.name);
    const file = path.join(dir, e.name);
    const stat = fs.statSync(file);
    if (stat.size === 0 || stat.size > MAX_ART_BYTES) {
      throw new CookieMcpError(
        `${e.name} is ${stat.size === 0 ? "empty" : `${(stat.size / 1e6).toFixed(1)} MB`}`,
        `each piece must be under ${MAX_ART_BYTES / 1e6} MB`,
      );
    }
    let meta: { name: string | null; attributes: Attribute[] } = { name: null, attributes: [] };
    const sidecar = json.get(stem);
    if (sidecar) {
      try {
        meta = readPieceMeta(JSON.parse(fs.readFileSync(path.join(dir, sidecar), "utf8")));
        withMetadata++;
      } catch {
        throw new CookieMcpError(`${sidecar} is not valid JSON`, "fix or remove it, then retry");
      }
    }
    pieces.push({ file, fileName: e.name, bytes: stat.size, ...meta });
    totalBytes += stat.size;
  }

  if (pieces.length < MIN_DROP_SUPPLY || pieces.length > MAX_DROP_SUPPLY) {
    throw new CookieMcpError(
      `the art folder has ${pieces.length} image(s); a drop has ${MIN_DROP_SUPPLY} to ${MAX_DROP_SUPPLY.toLocaleString("en-US")}`,
      "every image in the folder becomes one item of the drop",
    );
  }
  if (withMetadata > 0 && withMetadata < pieces.length) {
    warnings.push(
      `${pieces.length - withMetadata} piece(s) have no .json beside them, so no traits`,
    );
  }
  return { pieces, totalBytes, withMetadata, warnings };
}

/** Read one piece for upload, checking its bytes are the image its extension claims. */
export function readPiece(piece: ArtPiece): { bytes: Buffer; mimeType: string } {
  const bytes = fs.readFileSync(piece.file);
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType) {
    throw new CookieMcpError(
      `${piece.fileName} is not a PNG, JPEG, GIF or WebP image`,
      "the format is read from the file's own bytes, not its extension — convert it first",
    );
  }
  return { bytes, mimeType };
}

/** A single image (collection image, banner, placeholder) under the same confinement. */
export function readOneImage(input: string, what: string): ArtPiece {
  assertLocalFilesAllowed();
  const file = confined(input, imageRoot(), what);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ART_BYTES) {
    throw new CookieMcpError(
      `cannot use "${input.trim()}" as ${what}`,
      "pass a PNG/JPEG/GIF/WebP file under 25 MB",
    );
  }
  return { file, fileName: path.basename(file), bytes: stat.size, name: null, attributes: [] };
}
