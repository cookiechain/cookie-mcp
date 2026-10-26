import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { naturalCompare, readArtDir, readPiece, readPieceMeta } from "./art";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("readPieceMeta", () => {
  it("reads Metaplex attributes and a name", () => {
    expect(
      readPieceMeta({
        name: "Ape #7",
        attributes: [{ trait_type: "Fur", value: "Gold" }, { trait_type: "Eyes" }],
      }),
    ).toEqual({ name: "Ape #7", attributes: [{ trait_type: "Fur", value: "Gold" }] });
  });

  it("reads a flat traits object, numbers included", () => {
    expect(readPieceMeta({ traits: { Background: "Blue", Level: 3 } })).toEqual({
      name: null,
      attributes: [
        { trait_type: "Background", value: "Blue" },
        { trait_type: "Level", value: "3" },
      ],
    });
  });

  it("keeps what the launchpad keeps: 32 traits of 64 characters", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      trait_type: `t${i}`,
      value: "x".repeat(80),
    }));
    const { attributes } = readPieceMeta({ attributes: many });
    expect(attributes).toHaveLength(32);
    expect(attributes[0]!.value).toHaveLength(64);
  });
});

describe("naturalCompare", () => {
  it("puts 2 before 10", () => {
    expect(["10.png", "2.png", "1.png"].sort(naturalCompare)).toEqual(["1.png", "2.png", "10.png"]);
  });
});

describe("readArtDir", () => {
  let root: string;
  const prev = process.env.COOKIE_IMAGE_DIR;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nft-art-")));
    process.env.COOKIE_IMAGE_DIR = root;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.COOKIE_IMAGE_DIR;
    else process.env.COOKIE_IMAGE_DIR = prev;
  });
  const put = (name: string, body: Buffer | string) => {
    fs.mkdirSync(path.join(root, "art"), { recursive: true });
    fs.writeFileSync(path.join(root, "art", name), body);
  };

  it("lists images in natural order, joined to the JSON beside them", () => {
    put("10.png", PNG);
    put("2.png", PNG);
    put("1.PNG", PNG);
    put(
      "2.json",
      JSON.stringify({ name: "Two", attributes: [{ trait_type: "Fur", value: "Gold" }] }),
    );
    put("notes.txt", "hi");
    const art = readArtDir(path.join(root, "art"));
    expect(art.pieces.map((p) => p.fileName)).toEqual(["1.PNG", "2.png", "10.png"]);
    expect(art.pieces[1]).toMatchObject({
      name: "Two",
      attributes: [{ trait_type: "Fur", value: "Gold" }],
    });
    expect(art.withMetadata).toBe(1);
    expect(art.warnings.join(" ")).toMatch(/notes\.txt/);
    expect(art.warnings.join(" ")).toMatch(/2 piece\(s\) have no \.json/);
  });

  it("takes the image directory itself as the art folder", () => {
    fs.writeFileSync(path.join(root, "1.png"), PNG);
    fs.writeFileSync(path.join(root, "2.png"), PNG);
    expect(readArtDir(root).pieces.map((p) => p.fileName)).toEqual(["1.png", "2.png"]);
  });

  it("refuses two images with one name, since names are the join key", () => {
    put("a.png", PNG);
    put("A.jpg", PNG);
    expect(() => readArtDir(path.join(root, "art"))).toThrow(/share the name "a"/);
  });

  it("refuses a drop of one", () => {
    put("1.png", PNG);
    expect(() => readArtDir(path.join(root, "art"))).toThrow(/a drop has 2 to 10,000/);
  });

  it("refuses a folder outside the image directory", () => {
    expect(() => readArtDir(os.homedir() === root ? "/" : path.dirname(root))).toThrow(
      /under the image directory/,
    );
  });

  it("reads a piece's type from its bytes, not its extension", () => {
    put("1.png", PNG);
    put("2.png", "not an image");
    const art = readArtDir(path.join(root, "art"));
    expect(readPiece(art.pieces[0]!).mimeType).toBe("image/png");
    expect(() => readPiece(art.pieces[1]!)).toThrow(/not a PNG, JPEG, GIF or WebP/);
  });
});
