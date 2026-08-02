// Hand-encoded `cookie_domains` instructions + account decoders. Pure: PublicKey/Buffer only, no
// Connection, so every derivation and byte layout is unit-testable with golden values.
//
// Why hand-encoded rather than an anchor Program: the CookOven dApp has no backend to build
// transactions for us, and the instructions are tiny (a discriminator plus at most a borsh string or
// a pubkey). Discriminators come from `src/idl/cookie_domains.json` and are pinned by golden tests.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { PROGRAM_IDS } from "../config";

export const DOMAINS_PROGRAM_ID = new PublicKey(PROGRAM_IDS.cookieDomains);

export const CONFIG_SEED = Buffer.from("config");
export const DOMAIN_SEED = Buffer.from("domain");
export const PRIMARY_SEED = Buffer.from("primary");

export const IX_DISCRIMINATORS = {
  registerDomain: [236, 7, 208, 151, 173, 149, 73, 104],
  setPrimaryDomain: [18, 2, 170, 172, 190, 140, 242, 27],
  clearPrimaryDomain: [131, 7, 197, 14, 30, 164, 251, 111],
  transferDomain: [129, 115, 193, 43, 174, 5, 241, 52],
  transferDomainWithPrimaryCleanup: [49, 62, 30, 1, 52, 213, 52, 255],
  updateResolver: [108, 227, 28, 163, 123, 230, 190, 84],
  updateMetadata: [170, 182, 43, 239, 97, 78, 225, 186],
} as const;

export const ACCOUNT_DISCRIMINATORS = {
  config: [155, 12, 170, 224, 30, 250, 204, 130],
  domain: [35, 146, 98, 112, 13, 230, 231, 153],
  primary: [231, 255, 61, 63, 142, 184, 254, 42],
} as const;

/** `Pubkey::default()` — how the program spells "resolver/metadata unset". */
export const UNSET_PUBKEY = SystemProgram.programId.toBase58();

// --- PDAs ---------------------------------------------------------------------------------------

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], DOMAINS_PROGRAM_ID)[0];
}

/** `["domain", name]` — the name is the bare label, so the seed is capped at 32 bytes. */
export function domainPda(label: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DOMAIN_SEED, Buffer.from(label, "utf8")],
    DOMAINS_PROGRAM_ID,
  )[0];
}

/** `["primary", owner]` — one per wallet, holding the name it points at. */
export function primaryPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([PRIMARY_SEED, owner.toBuffer()], DOMAINS_PROGRAM_ID)[0];
}

// --- Encoding -----------------------------------------------------------------------------------

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function ixData(disc: readonly number[], ...rest: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(disc), ...rest]);
}

export function encodeRegisterDomainData(label: string): Buffer {
  return ixData(IX_DISCRIMINATORS.registerDomain, borshString(label));
}

export function encodeTransferDomainData(newOwner: PublicKey, withCleanup: boolean): Buffer {
  const disc = withCleanup
    ? IX_DISCRIMINATORS.transferDomainWithPrimaryCleanup
    : IX_DISCRIMINATORS.transferDomain;
  return ixData(disc, newOwner.toBuffer());
}

// --- Instructions -------------------------------------------------------------------------------

/**
 * `register_domain` — creates the domain PDA and pays `fee_receiver` the tier price. `fee_receiver`
 * must be the one named in `config` (anchor `relations`), so it is always read from the live config
 * rather than hardcoded.
 */
export function registerDomainIx(args: {
  label: string;
  payer: PublicKey;
  feeReceiver: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAINS_PROGRAM_ID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: domainPda(args.label), isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.feeReceiver, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeRegisterDomainData(args.label),
  });
}

/** `set_primary_domain` — init-if-needed on the `["primary", owner]` PDA, hence the system program. */
export function setPrimaryDomainIx(args: {
  label: string;
  owner: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAINS_PROGRAM_ID,
    keys: [
      { pubkey: primaryPda(args.owner), isSigner: false, isWritable: true },
      { pubkey: domainPda(args.label), isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATORS.setPrimaryDomain),
  });
}

export function clearPrimaryDomainIx(args: { owner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAINS_PROGRAM_ID,
    keys: [
      { pubkey: primaryPda(args.owner), isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATORS.clearPrimaryDomain),
  });
}

/**
 * `transfer_domain`, or `transfer_domain_with_primary_cleanup` when the name being handed over is
 * the sender's own primary. The plain variant leaves the sender's `PrimaryDomain` pointing at a name
 * they no longer own; the cleanup variant takes the primary PDA as a third account and resets it.
 * It requires that account to exist, so only pass `withCleanup` when it does — see
 * `transferNeedsPrimaryCleanup`.
 */
export function transferDomainIx(args: {
  label: string;
  currentOwner: PublicKey;
  newOwner: PublicKey;
  withCleanup: boolean;
}): TransactionInstruction {
  const keys = [
    { pubkey: domainPda(args.label), isSigner: false, isWritable: true },
    ...(args.withCleanup
      ? [{ pubkey: primaryPda(args.currentOwner), isSigner: false, isWritable: true }]
      : []),
    { pubkey: args.currentOwner, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: DOMAINS_PROGRAM_ID,
    keys,
    data: encodeTransferDomainData(args.newOwner, args.withCleanup),
  });
}

/**
 * Transferring a name away should not leave the sender's primary pointing at it. True only when the
 * sender's primary IS this name — the cleanup instruction would fail on a wallet that has never set
 * one, because its `PrimaryDomain` account does not exist.
 */
export function transferNeedsPrimaryCleanup(label: string, currentPrimary: string | null): boolean {
  return currentPrimary !== null && currentPrimary === label;
}

/** `update_resolver` / `update_metadata` — same shape, both owner-signed, both take one pubkey. */
export function updateDomainPointerIx(args: {
  label: string;
  owner: PublicKey;
  field: "resolver" | "metadata";
  value: PublicKey;
}): TransactionInstruction {
  const disc =
    args.field === "resolver" ? IX_DISCRIMINATORS.updateResolver : IX_DISCRIMINATORS.updateMetadata;
  return new TransactionInstruction({
    programId: DOMAINS_PROGRAM_ID,
    keys: [
      { pubkey: domainPda(args.label), isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: ixData(disc, args.value.toBuffer()),
  });
}

// --- Decoding -----------------------------------------------------------------------------------

function hasDiscriminator(data: Buffer, disc: readonly number[]): boolean {
  return data.length >= 8 && Buffer.from(disc).equals(data.subarray(0, 8));
}

/**
 * `DomainAccount`, allocated at 149 bytes = 8 disc + (4 + 32) name + 3 × 32 pubkey + 8 i64 + 1 bump.
 * Borsh packs the fields right after the ACTUAL name bytes, so every offset past the name is
 * dynamic.
 *
 * Two accounts on the live registry (`test-test-001`/`-002`, May 2026) are 85 bytes: an older layout
 * with no `resolver`/`metadata`. The program itself can no longer deserialize them — a write against
 * one reverts with `AccountDidNotDeserialize` — but they still show up in an enumeration, so decode
 * them as `legacy` instead of reading `created_at` as a resolver pubkey.
 */
export const DOMAIN_ACCOUNT_SIZE = 149;
export const LEGACY_DOMAIN_ACCOUNT_SIZE = 85;
export const PRIMARY_ACCOUNT_SIZE = 77;

export interface DecodedDomain {
  name: string;
  owner: string;
  /** null when unset (`Pubkey::default()`) or absent from the legacy layout. */
  resolver: string | null;
  metadata: string | null;
  /** Unix seconds; null on the legacy layout, whose field order differs. */
  createdAt: number | null;
  legacy: boolean;
}

export function decodeDomainAccount(data: Buffer): DecodedDomain | null {
  if (!hasDiscriminator(data, ACCOUNT_DISCRIMINATORS.domain)) return null;
  if (data.length < 12) return null;
  const nameLen = data.readUInt32LE(8);
  const end = 12 + nameLen;
  if (nameLen === 0 || end + 32 > data.length) return null;
  const name = data.subarray(12, end).toString("utf8");
  const owner = new PublicKey(data.subarray(end, end + 32)).toBase58();

  // Current layout only; anything smaller is the pre-resolver account.
  if (data.length < DOMAIN_ACCOUNT_SIZE || end + 105 > data.length) {
    return { name, owner, resolver: null, metadata: null, createdAt: null, legacy: true };
  }
  const opt = (o: number): string | null => {
    const k = new PublicKey(data.subarray(o, o + 32)).toBase58();
    return k === UNSET_PUBKEY ? null : k;
  };
  return {
    name,
    owner,
    resolver: opt(end + 32),
    metadata: opt(end + 64),
    createdAt: Number(data.readBigInt64LE(end + 96)),
    legacy: false,
  };
}

/**
 * `PrimaryDomain` = 8 disc + 32 owner + (4 + 32) name + 1 bump. `clear_primary_domain` leaves the
 * account in place with an EMPTY name, so "the account exists" is not the same as "a primary is
 * set" — an empty name decodes to null.
 */
export function decodePrimaryAccount(data: Buffer): { owner: string; name: string | null } | null {
  if (!hasDiscriminator(data, ACCOUNT_DISCRIMINATORS.primary)) return null;
  if (data.length < 44) return null;
  const owner = new PublicKey(data.subarray(8, 40)).toBase58();
  const len = data.readUInt32LE(40);
  if (44 + len > data.length) return null;
  const name = len === 0 ? null : data.subarray(44, 44 + len).toString("utf8");
  return { owner, name };
}

export function decodeDomainsConfigAccount(data: Buffer): {
  admin: string;
  feeReceiver: string;
  cookUsdPriceMicro: bigint;
  shortNameUsdCents: bigint;
  longNameUsdCents: bigint;
  nativeDecimals: number;
} | null {
  if (!hasDiscriminator(data, ACCOUNT_DISCRIMINATORS.config)) return null;
  if (data.length < 98) return null;
  return {
    admin: new PublicKey(data.subarray(8, 40)).toBase58(),
    feeReceiver: new PublicKey(data.subarray(40, 72)).toBase58(),
    cookUsdPriceMicro: data.readBigUInt64LE(72),
    shortNameUsdCents: data.readBigUInt64LE(80),
    longNameUsdCents: data.readBigUInt64LE(88),
    nativeDecimals: data.readUInt8(96),
  };
}

// --- Errors -------------------------------------------------------------------------------------

/**
 * Anchor errors from `cookie_domains`. 6002 and 6003 were confirmed by simulating against the live
 * deployment (`InvalidName` for an empty / uppercase / underscored name, `NotDomainOwner` for
 * set-primary and transfer on a name owned by someone else); the rest come from the IDL. 6000/6001
 * appear to be unreachable in practice — an empty name answers `InvalidName`, and a name over 32
 * bytes cannot be turned into a PDA seed at all.
 */
export const DOMAIN_ERRORS: Record<number, string> = {
  6000: "the domain name is too short",
  6001: "the domain name is too long",
  6002: "invalid domain name — use 1–32 characters of a-z, 0-9 and hyphens (lowercase)",
  6003: "you are not the owner of this domain",
  6004: "the registry's configured price is invalid",
  6005: "the registry's configured decimals are invalid",
  6006: "invalid admin wallet",
  6007: "invalid fee receiver wallet",
  6008: "invalid new owner wallet",
  6009: "math overflow in the registry",
  6010: "invalid primary domain owner",
};

/**
 * Turn a failed simulation into something an agent can act on. Two non-anchor cases matter more than
 * the error table:
 *   - the SYSTEM program's `custom program error: 0x0` on `register_domain` means the domain PDA
 *     already exists, i.e. the name is taken — the single most likely failure, and unreadable as-is;
 *   - `0x1` from the system program is "insufficient lamports", which for a registration means the
 *     wallet cannot cover the price.
 */
export function domainSimError(logs: string[], label?: string): string | null {
  const blob = logs.join(" ");
  const anchor = /Error Number: (\d+)/.exec(blob);
  if (anchor) {
    const msg = DOMAIN_ERRORS[Number(anchor[1])];
    if (msg) return msg;
  }
  const systemFailed = /Program 11111111111111111111111111111111 failed: custom program error: 0x0/;
  if (systemFailed.test(blob)) {
    return label ? `${label}.cook is already registered` : "that domain name is already registered";
  }
  const insufficient = /insufficient lamports (\d+), need (\d+)/.exec(blob);
  if (insufficient) {
    return `insufficient COOK: the wallet holds ${insufficient[1]} lamports, the transaction needs ${insufficient[2]}`;
  }
  return null;
}
