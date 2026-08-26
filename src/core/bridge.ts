// bridge — move COOK 1:1 between Cookie Chain and Solana mainnet over Hyperlane warp routes.
//
// This is a self-contained port of hyperlane-cookies/backend/lib/hyperlaneSealevel.ts (the same
// transfer-remote flow the Hyperlane SDK uses, reimplemented without the SDK runtime). Cookie side is
// a `native` warp (locks native COOK); Solana side is a `collateral` warp (locks SPL COOK, a
// Token-2022 mint). The instruction data is hand-encoded (no borsh dep) — the layout is fixed:
// [8-byte discriminator][u8 instruction=1][u32 dest domain LE][32-byte recipient][u256 amount LE].
//
// Flow: build the transfer-remote tx → partial-sign the ephemeral "unique message" signer (replay
// protection, per Hyperlane) → add the wallet signature → simulate → send + confirm on the SOURCE
// chain → extract the Hyperlane message id from logs. A relayer then delivers on the far side in a few
// minutes; delivery is verifiable via the destination mailbox's processed_message PDA.
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  BRIDGE,
  COOKIE_DOMAIN,
  COOKIE_WARP_PROGRAM_ID,
  SOLANA_DOMAIN,
  SOLANA_WARP_PROGRAM_ID,
  explorerTxUrl,
  solanaExplorerTxUrl,
} from "./config";
import { confirmSent } from "./confirm";
import { CookieMcpError } from "./errors";
import { getConnection, getSolanaConnection } from "./rpc";
import { requireWallet, ownPublicKey } from "./wallet";
import { rawToUi, uiToRaw } from "./format";

// Standard Solana SPL no-op program used by Hyperlane for log emission.
const SPL_NOOP_PROGRAM_ID = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const DISCRIMINATOR = Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]);
const TRANSFER_REMOTE_INSTRUCTION = 1;
const COMPUTE_LIMIT = 1_000_000;
const SEP = "-";

export type BridgeDirection = "cookie-to-solana" | "solana-to-cookie";

// --- Instruction encoding (fixed layout, hand-rolled to avoid a borsh dependency) ---------------

/** Encode transfer-remote ix data: disc(8) + instruction u8 + destDomain u32 LE + recipient[32] +
 *  amount u256 LE. Byte-for-byte equal to the borsh-serialized form the Rust warp processor expects. */
export function encodeTransferRemoteIxData(
  destinationDomain: number,
  recipient32: Uint8Array,
  amount: bigint,
): Buffer {
  if (recipient32.length !== 32) {
    throw new Error(`recipient must be 32 bytes, got ${recipient32.length}`);
  }
  const buf = Buffer.alloc(8 + 1 + 4 + 32 + 32);
  DISCRIMINATOR.copy(buf, 0);
  buf.writeUInt8(TRANSFER_REMOTE_INSTRUCTION, 8);
  buf.writeUInt32LE(destinationDomain, 9);
  Buffer.from(recipient32).copy(buf, 13);
  let a = amount;
  for (let i = 0; i < 32; i++) {
    buf[45 + i] = Number(a & 0xffn);
    a >>= 8n;
  }
  if (a !== 0n) throw new Error("amount exceeds u256");
  return buf;
}

/** Convert a base58 (Sealevel) or 0x-hex recipient into a 32-byte buffer. */
export function recipientTo32(recipient: string): Uint8Array {
  if (recipient.startsWith("0x")) {
    const hex = recipient.slice(2);
    if (hex.length !== 64) {
      throw new Error(`hex recipient must be 32 bytes (64 hex chars), got ${hex.length}`);
    }
    return Buffer.from(hex, "hex");
  }
  return new PublicKey(recipient).toBytes();
}

// --- PDA derivation (seeds joined by a literal '-', per the Hyperlane sealevel programs) ---------

function pda(seeds: Array<string | Buffer>, programId: PublicKey): PublicKey {
  const seedBuffers = seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s));
  return PublicKey.findProgramAddressSync(seedBuffers, programId)[0];
}

const deriveMailboxOutbox = (mailbox: PublicKey) => pda(["hyperlane", SEP, "outbox"], mailbox);
const deriveDispatchAuthority = (warp: PublicKey) =>
  pda(["hyperlane_dispatcher", SEP, "dispatch_authority"], warp);
const deriveDispatchedMessage = (mailbox: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane", SEP, "dispatched_message", SEP, uniqueMsg.toBuffer()], mailbox);
const deriveTokenPda = (warp: PublicKey) =>
  pda(["hyperlane_message_recipient", SEP, "handle", SEP, "account_metas"], warp);
export const deriveNativeCollateralPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "native_collateral"], warp);
export const deriveEscrowPda = (warp: PublicKey) => pda(["hyperlane_token", SEP, "escrow"], warp);
/** The route's ATA-payer PDA. On a cookie→solana delivery the warp program creates the recipient's SPL
 *  COOK associated token account if it doesn't exist and pays the rent out of this account — see the
 *  recipient-account preflight below. It is a plain system account with no data. */
export const deriveAtaPayerPda = (warp: PublicKey) =>
  pda(["hyperlane_token", SEP, "ata_payer"], warp);
const deriveIgpProgramData = (igpProgramId: PublicKey) =>
  pda(["hyperlane_igp", SEP, "program_data"], igpProgramId);
const deriveGasPayment = (igpProgramId: PublicKey, uniqueMsg: PublicKey) =>
  pda(["hyperlane_igp", SEP, "gas_payment", SEP, uniqueMsg.toBuffer()], igpProgramId);
const deriveProcessedMessage = (mailbox: PublicKey, idBytes: Buffer) =>
  pda(["hyperlane", SEP, "processed_message", SEP, idBytes], mailbox);

/**
 * Read the inner IGP pubkey from an OverheadIgpAccount's data. Layout (verified on-chain):
 *   initialized u8(1) · discriminator [8] · bump u8(1) · salt H256(32) · owner Option<Pubkey>(1+0|32)
 *   · inner Pubkey(32) ← what we want · gas_overheads HashMap.
 */
async function readOverheadIgpInner(
  conn: Connection,
  overheadIgpAccount: PublicKey,
): Promise<PublicKey> {
  const info = await conn.getAccountInfo(overheadIgpAccount, "confirmed");
  if (!info) {
    throw new CookieMcpError(
      `Hyperlane OverheadIgp account not found: ${overheadIgpAccount.toBase58()}`,
      "the bridge IGP address may be wrong for this network — check the *_OVERHEAD_IGP_ACCOUNT env",
    );
  }
  const buf = info.data;
  let off = 42; // initialized(1) + discriminator(8) + bump(1) + salt(32)
  const ownerTag = buf.readUInt8(off);
  off += 1;
  if (ownerTag === 1) off += 32;
  const innerBytes = buf.subarray(off, off + 32);
  if (innerBytes.length !== 32) {
    throw new CookieMcpError(
      `failed to read inner IGP pubkey from ${overheadIgpAccount.toBase58()}`,
      "the OverheadIgp account layout was unexpected",
    );
  }
  return new PublicKey(innerBytes);
}

/** Parse the Hyperlane dispatch message id (0x…64 hex) from confirmed tx logs. */
export function messageIdFromLogs(logs: string[] | null | undefined): string | null {
  if (!logs?.length) return null;
  for (const line of logs) {
    const m = line.match(/ID (0x[a-fA-F0-9]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  for (const line of logs) {
    const m = line.match(/(0x[a-fA-F0-9]{64})/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// --- Route wiring ------------------------------------------------------------------------------

interface Route {
  type: "native" | "collateral";
  sourceConn: Connection;
  destConn: Connection;
  sourceDecimals: number;
  destinationDomain: number;
  warp: PublicKey;
  mailbox: PublicKey;
  igpProgramId: PublicKey;
  overheadIgp: PublicKey;
  splMint?: PublicKey;
  destDecimals: number;
  /** Where the destination chain pays the release from — see assertDestinationCollateral. */
  destCollateral: PublicKey | null;
  destCollateralKind: "native" | "tokenAccount";
  /** Cookie→Solana only: the SPL mint credited on the far side, and the PDA that pays to create the
   *  recipient's token account when they don't have one yet. */
  destSplMint?: PublicKey;
  destAtaPayer: PublicKey | null;
  destMailbox: PublicKey;
  sourceChain: "cookie" | "solana";
  sourceExplorerTxUrl: (sig: string) => string;
}

function parsePk(addr: string, label: string): PublicKey {
  try {
    return new PublicKey(addr);
  } catch {
    throw new CookieMcpError(`invalid ${label}: ${addr}`, "expected a base58 pubkey");
  }
}

/** The far side's warp program id only matters for the collateral preflight, and both ids ship as
 *  defaults — so a missing/garbled one downgrades the check to "unchecked" rather than failing the
 *  bridge, preserving the behaviour from before the preflight existed. */
function optionalPk(
  addr: string | undefined,
  derive: (warp: PublicKey) => PublicKey,
): PublicKey | null {
  if (!addr) return null;
  try {
    return derive(new PublicKey(addr));
  } catch {
    return null;
  }
}

function resolveRoute(direction: BridgeDirection): Route {
  if (direction === "cookie-to-solana") {
    if (!COOKIE_WARP_PROGRAM_ID) {
      throw new CookieMcpError(
        "COOKIE_WARP_PROGRAM_ID is not set",
        "the Cookie-side Hyperlane warp route program id is a deploy output not shipped in the repo — set COOKIE_WARP_PROGRAM_ID (and SOLANA_WARP_PROGRAM_ID) in the environment",
      );
    }
    return {
      type: "native",
      sourceConn: getConnection(),
      destConn: getSolanaConnection(),
      sourceDecimals: BRIDGE.cookie.decimals,
      destinationDomain: SOLANA_DOMAIN,
      warp: parsePk(COOKIE_WARP_PROGRAM_ID, "COOKIE_WARP_PROGRAM_ID"),
      mailbox: parsePk(BRIDGE.cookie.mailbox, "cookie mailbox"),
      igpProgramId: parsePk(BRIDGE.cookie.igpProgramId, "cookie IGP program"),
      overheadIgp: parsePk(BRIDGE.cookie.overheadIgp, "cookie overhead IGP"),
      destDecimals: BRIDGE.solana.decimals,
      destCollateral: optionalPk(SOLANA_WARP_PROGRAM_ID, deriveEscrowPda),
      destCollateralKind: "tokenAccount",
      destSplMint: parsePk(BRIDGE.solana.splMint, "solana COOK mint"),
      destAtaPayer: optionalPk(SOLANA_WARP_PROGRAM_ID, deriveAtaPayerPda),
      destMailbox: parsePk(BRIDGE.solana.mailbox, "solana mailbox"),
      sourceChain: "cookie",
      sourceExplorerTxUrl: explorerTxUrl,
    };
  }
  if (!SOLANA_WARP_PROGRAM_ID) {
    throw new CookieMcpError(
      "SOLANA_WARP_PROGRAM_ID is not set",
      "the Solana-side Hyperlane warp route program id is a deploy output not shipped in the repo — set SOLANA_WARP_PROGRAM_ID (and COOKIE_WARP_PROGRAM_ID) in the environment",
    );
  }
  return {
    type: "collateral",
    sourceConn: getSolanaConnection(),
    destConn: getConnection(),
    sourceDecimals: BRIDGE.solana.decimals,
    destinationDomain: COOKIE_DOMAIN,
    warp: parsePk(SOLANA_WARP_PROGRAM_ID, "SOLANA_WARP_PROGRAM_ID"),
    mailbox: parsePk(BRIDGE.solana.mailbox, "solana mailbox"),
    igpProgramId: parsePk(BRIDGE.solana.igpProgramId, "solana IGP program"),
    overheadIgp: parsePk(BRIDGE.solana.overheadIgp, "solana overhead IGP"),
    splMint: parsePk(BRIDGE.solana.splMint, "solana COOK mint"),
    destDecimals: BRIDGE.cookie.decimals,
    destCollateral: optionalPk(COOKIE_WARP_PROGRAM_ID, deriveNativeCollateralPda),
    destCollateralKind: "native",
    destAtaPayer: null, // native release: the recipient is a wallet, there is no account to create
    destMailbox: parsePk(BRIDGE.cookie.mailbox, "cookie mailbox"),
    sourceChain: "solana",
    sourceExplorerTxUrl: solanaExplorerTxUrl,
  };
}

// --- Instruction builder -----------------------------------------------------------------------

async function buildTransferRemoteIx(
  route: Route,
  sender: PublicKey,
  uniqueMsg: PublicKey,
  recipient32: Uint8Array,
  amount: bigint,
): Promise<TransactionInstruction> {
  const { warp, mailbox, igpProgramId, overheadIgp, sourceConn, type } = route;
  const innerIgp = await readOverheadIgpInner(sourceConn, overheadIgp);

  const baseKeys: AccountMeta[] = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 0 system
    { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // 1 spl_noop
    { pubkey: deriveTokenPda(warp), isSigner: false, isWritable: false }, // 2 token PDA
    { pubkey: mailbox, isSigner: false, isWritable: false }, // 3 mailbox program
    { pubkey: deriveMailboxOutbox(mailbox), isSigner: false, isWritable: true }, // 4 outbox (w)
    { pubkey: deriveDispatchAuthority(warp), isSigner: false, isWritable: false }, // 5 dispatch auth
    { pubkey: sender, isSigner: true, isWritable: false }, // 6 sender (signer)
    { pubkey: uniqueMsg, isSigner: true, isWritable: false }, // 7 unique message signer
    { pubkey: deriveDispatchedMessage(mailbox, uniqueMsg), isSigner: false, isWritable: true }, // 8 (w)
    { pubkey: igpProgramId, isSigner: false, isWritable: false }, // 9 IGP program
    { pubkey: deriveIgpProgramData(igpProgramId), isSigner: false, isWritable: true }, // 10 (w)
    { pubkey: deriveGasPayment(igpProgramId, uniqueMsg), isSigner: false, isWritable: true }, // 11 (w)
    { pubkey: overheadIgp, isSigner: false, isWritable: false }, // 12 overhead IGP
    { pubkey: innerIgp, isSigner: false, isWritable: true }, // 13 inner IGP (w)
  ];

  let extraKeys: AccountMeta[];
  if (type === "native") {
    extraKeys = [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 14 system (again)
      { pubkey: deriveNativeCollateralPda(warp), isSigner: false, isWritable: true }, // 15 collateral (w)
    ];
  } else {
    const mint = route.splMint!;
    // Read the token program from the mint owner — mainnet COOK is Token-2022, so passing the classic
    // TOKEN_PROGRAM_ID would make the warp reject the tx.
    const mintInfo = await sourceConn.getAccountInfo(mint, "confirmed");
    if (!mintInfo) {
      throw new CookieMcpError(
        `SPL COOK mint not found on Solana: ${mint.toBase58()}`,
        "check COOK_SPL_MINT / SOLANA_RPC_URL",
      );
    }
    const tokenProgram = mintInfo.owner;
    const senderAta = getAssociatedTokenAddressSync(mint, sender, true, tokenProgram);
    extraKeys = [
      { pubkey: tokenProgram, isSigner: false, isWritable: false }, // 14 token program
      { pubkey: mint, isSigner: false, isWritable: true }, // 15 mint (w)
      { pubkey: senderAta, isSigner: false, isWritable: true }, // 16 sender ATA (w)
      { pubkey: deriveEscrowPda(warp), isSigner: false, isWritable: true }, // 17 escrow (w)
    ];
  }

  return new TransactionInstruction({
    keys: [...baseKeys, ...extraKeys],
    programId: warp,
    data: encodeTransferRemoteIxData(route.destinationDomain, recipient32, amount),
  });
}

// --- Destination collateral preflight ----------------------------------------------------------
// Neither side of the warp route mints: a transfer is RELEASED from the destination chain's collateral
// account (Cookie's native-collateral PDA, or the Solana escrow). If that account is short, the source
// tx still succeeds — it locks your funds and dispatches the message — and only the relayer's delivery
// on the far side fails. simulateTransaction runs against the SOURCE chain, so it can never catch this.
// Hence an explicit read of the destination before signing.
//
// The two accounts need DIFFERENT reads: the Cookie PDA holds native COOK (a lamport balance), while
// the Solana escrow IS the token account itself, not a wallet owning an ATA — an owner-based ATA lookup
// finds nothing there and would report 0.

/** Rescale a raw amount between the two sides' decimals (Cookie 9, Solana 6). Scaling down truncates,
 *  which can only UNDERstate the requirement by sub-dust — never overstate it into a false failure. */
export function scaleRaw(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw;
  const diff = BigInt(Math.abs(toDecimals - fromDecimals));
  const factor = 10n ** diff;
  return toDecimals > fromDecimals ? raw * factor : raw / factor;
}

/** Available collateral in the destination's raw units, or null when it can't be determined (missing
 *  warp id, unreadable account, RPC failure) — an unknown is reported, never treated as zero. */
async function readDestinationCollateral(route: Route): Promise<bigint | null> {
  const acct = route.destCollateral;
  if (!acct) return null;
  try {
    if (route.destCollateralKind === "tokenAccount") {
      const bal = await route.destConn.getTokenAccountBalance(acct, "confirmed");
      return BigInt(bal.value.amount);
    }
    // Native side: the PDA carries account data, so its rent-exempt reserve is NOT releasable.
    // Subtract it rather than counting it as available collateral.
    const info = await route.destConn.getAccountInfo(acct, "confirmed");
    if (!info) return null;
    const rent = await route.destConn.getMinimumBalanceForRentExemption(info.data.length);
    const free = BigInt(info.lamports) - BigInt(rent);
    return free > 0n ? free : 0n;
  } catch {
    return null;
  }
}

/** Throws when the destination provably cannot cover the release. Returns the collateral as a UI
 *  amount for the result, or null when the check couldn't run. */
async function assertDestinationCollateral(
  route: Route,
  amountRaw: bigint,
): Promise<string | null> {
  const available = await readDestinationCollateral(route);
  if (available === null) return null;
  const needed = scaleRaw(amountRaw, route.sourceDecimals, route.destDecimals);
  if (available < needed) {
    const destChain = route.sourceChain === "cookie" ? "Solana" : "Cookie Chain";
    throw new CookieMcpError(
      `not enough bridge collateral on ${destChain}: the route can release ` +
        `${rawToUi(available, route.destDecimals)} COOK but this transfer needs ` +
        `${rawToUi(needed, route.destDecimals)}`,
      "nothing was signed. The warp route releases from a fixed collateral account, so a larger " +
        "transfer than it holds would lock your funds on this side with an undeliverable message — " +
        "bridge a smaller amount, or wait for the route's collateral to be topped up",
    );
  }
  return rawToUi(available, route.destDecimals);
}

// --- Recipient token account (cookie → solana only) --------------------------------------------
// The Solana delivery credits ATA(recipient, COOK mint). If that account doesn't exist yet, the warp
// program creates it and pays the rent from its `ata_payer` PDA. That PDA is funded ONCE at deploy time
// (0.05 SOL by default — about 24 accounts) and is never topped up automatically, so it runs dry. When
// it can no longer cover one account's rent, delivery to any NEW recipient fails inside the relayer —
// and because the relayer simulates before submitting, nothing lands on chain, nothing errors, and the
// transfer just hangs. Observed 2026-08-26 on a UI bridge; it only moved after someone created the
// recipient's token account by hand. Neither the source-chain simulation nor the collateral preflight
// above can see it (the escrow was full — it was SOL for rent that was missing, not COOK).
//
// So don't depend on that PDA: when the recipient has no COOK account, create it ourselves first, from
// this wallet, on Solana, and confirm it BEFORE dispatching on Cookie Chain. That is one extra ~0.0021
// SOL account rent (the recipient can reclaim it by closing the account) in exchange for removing a
// shared, silently-drainable dependency from the path. It runs first precisely so that a failure here
// costs nothing: nothing is locked on the source chain yet.

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Token-2022 associated accounts carry the ImmutableOwner extension: the 165-byte classic layout plus
 *  a 1-byte account type and a 4-byte extension header. Mainnet COOK is Token-2022, so this is the size
 *  that matters here — 170 bytes ⇒ ~0.00207 SOL of rent, more than a classic ATA. */
const ATA_LEN_CLASSIC = 165;
const ATA_LEN_TOKEN_2022 = 170;
/** Left spare for the creation tx's own fee (a signature is 5000 lamports; keep room for a retry). */
const ATA_CREATE_FEE_BUFFER = 15_000n;

/** Lamports the funder is SHORT of creating one token account, or 0n when it can afford it.
 *  `reserve` is whatever must stay behind: for the route's ata_payer that's its own rent-exempt minimum
 *  (a system account with no data still has one, and a transfer dipping below it fails); for our wallet
 *  it's the fee headroom. Either way the reserve is subtracted, never counted as available. */
export function ataPayerShortfall(args: {
  payerLamports: bigint;
  payerRentReserve: bigint;
  ataRent: bigint;
}): bigint {
  const spendable = args.payerLamports - args.payerRentReserve;
  const short = args.ataRent - (spendable > 0n ? spendable : 0n);
  return short > 0n ? short : 0n;
}

export interface RecipientTokenAccountInfo {
  /** The recipient's SPL COOK associated token account on Solana. */
  address: string;
  /** Whether it already existed when the bridge started. */
  exists: boolean;
  /** Signature of the account-creation tx this bridge sent first, or null when none was needed. */
  createdSignature: string | null;
  /** Whether the route's own ATA payer could have covered it. Informational — null when not checked. */
  routePayerCanFund: boolean | null;
}

interface RecipientAtaRead {
  ata: PublicKey;
  tokenProgram: PublicKey;
  exists: boolean;
  ataRent: bigint;
  /** What the route's ata_payer is short by; 0n when it can pay, null when not checked. */
  routePayerShortfall: bigint | null;
}

/** Reads the far side, or null when any part of it is unreadable (missing mint, RPC failure) — an
 *  unknown is reported as unchecked and the bridge proceeds as it did before this check existed. */
async function readRecipientAta(
  route: Route,
  recipient: PublicKey,
): Promise<RecipientAtaRead | null> {
  if (route.type !== "native" || !route.destSplMint) return null; // solana→cookie: no account to create
  const conn = route.destConn;
  try {
    // Read the token program from the mint owner — mainnet COOK is Token-2022, and that decides both
    // the ATA address and its size.
    const mintInfo = await conn.getAccountInfo(route.destSplMint, "confirmed");
    if (!mintInfo) return null;
    const tokenProgram = mintInfo.owner;
    const ata = getAssociatedTokenAddressSync(route.destSplMint, recipient, true, tokenProgram);
    const ataInfo = await conn.getAccountInfo(ata, "confirmed");
    if (ataInfo) {
      return { ata, tokenProgram, exists: true, ataRent: 0n, routePayerShortfall: null };
    }

    const ataLen = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? ATA_LEN_TOKEN_2022
      : ATA_LEN_CLASSIC;
    const ataRent = BigInt(await conn.getMinimumBalanceForRentExemption(ataLen));
    let routePayerShortfall: bigint | null = null;
    if (route.destAtaPayer) {
      const [payer, payerReserve] = await Promise.all([
        conn.getAccountInfo(route.destAtaPayer, "confirmed"),
        conn.getMinimumBalanceForRentExemption(0),
      ]);
      routePayerShortfall = ataPayerShortfall({
        payerLamports: BigInt(payer?.lamports ?? 0),
        payerRentReserve: BigInt(payerReserve),
        ataRent,
      });
    }
    return { ata, tokenProgram, exists: false, ataRent, routePayerShortfall };
  } catch {
    return null;
  }
}

/** Creates the recipient's COOK account on Solana if they don't have one, paid by this wallet, and
 *  confirms it before the caller dispatches anything. Returns null when the check couldn't run.
 *  Throws only when the account is missing AND cannot be created — in which case nothing was signed on
 *  the source chain, so the bridge is simply refused. */
async function ensureRecipientTokenAccount(
  route: Route,
  recipient: PublicKey,
  keypair: Keypair,
  opts: { create: boolean },
): Promise<RecipientTokenAccountInfo | null> {
  const read = await readRecipientAta(route, recipient);
  if (!read) return null;
  const routePayerCanFund =
    read.routePayerShortfall === null ? null : read.routePayerShortfall === 0n;
  if (read.exists) {
    return {
      address: read.ata.toBase58(),
      exists: true,
      createdSignature: null,
      routePayerCanFund,
    };
  }

  const base = { address: read.ata.toBase58(), exists: false, routePayerCanFund };

  // Opted out of creating it: fall back to leaning on the route's payer, and refuse if it's dry.
  if (!opts.create) {
    if (routePayerCanFund === false) {
      throw new CookieMcpError(
        `the recipient has no COOK account on Solana and the bridge route cannot pay to create one: ` +
          `its ATA payer ${route.destAtaPayer!.toBase58()} is short ` +
          `${rawToUi(read.routePayerShortfall!, 9)} SOL of the ${rawToUi(read.ataRent, 9)} SOL rent`,
        "nothing was signed. The relayer's delivery would fail in simulation and never reach the " +
          "chain, so the source transfer would lock your COOK and hang with no error anywhere. Drop " +
          "createRecipientAccount:false to let this wallet create the account instead (it needs the " +
          "rent in SOL on Solana), or have the payer PDA topped up.",
      );
    }
    return { ...base, createdSignature: null };
  }

  const conn = route.destConn;
  const solBalance = BigInt(await conn.getBalance(keypair.publicKey, "confirmed"));
  const shortfall = ataPayerShortfall({
    payerLamports: solBalance,
    payerRentReserve: ATA_CREATE_FEE_BUFFER,
    ataRent: read.ataRent,
  });
  if (shortfall > 0n) {
    throw new CookieMcpError(
      `the recipient has no COOK account on Solana and this wallet is ${rawToUi(shortfall, 9)} SOL ` +
        `short of creating one (needs ${rawToUi(read.ataRent, 9)} SOL of rent plus fees, holds ` +
        `${rawToUi(solBalance, 9)} SOL on Solana)`,
      "nothing was signed. A cookie-to-solana delivery has to credit an SPL token account, and the " +
        "recipient doesn't have one — bridging before it exists risks a transfer that locks your COOK " +
        "and hangs undelivered. Fund this wallet with a little SOL on Solana mainnet, or bridge to an " +
        "address that already holds COOK there.",
    );
  }

  // Idempotent: harmless if the relayer, the recipient, or a concurrent bridge wins the race.
  const createIx = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    read.ata,
    recipient,
    route.destSplMint!,
    read.tokenProgram,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(
    createIx,
  );
  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  // Confirm before the caller dispatches: the bridge must not go out against an unconfirmed account.
  await confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, "recipient-account", {
    explorerUrl: solanaExplorerTxUrl(signature),
  });
  return { ...base, createdSignature: signature };
}

// --- Delivery check ----------------------------------------------------------------------------

async function isDelivered(
  conn: Connection,
  destMailbox: PublicKey,
  messageIdHex: string,
): Promise<{ delivered: boolean; destinationTx: string | null }> {
  const id = messageIdHex.startsWith("0x") ? messageIdHex.slice(2) : messageIdHex;
  if (id.length !== 64) return { delivered: false, destinationTx: null };
  const idBytes = Buffer.from(id, "hex");
  const processedPda = deriveProcessedMessage(destMailbox, idBytes);
  const info = await conn.getAccountInfo(processedPda, "confirmed");
  if (!info) return { delivered: false, destinationTx: null };
  const sigs = await conn.getSignaturesForAddress(processedPda, { limit: 1 });
  return { delivered: true, destinationTx: sigs[0]?.signature ?? null };
}

// --- Public API --------------------------------------------------------------------------------

export interface BridgeResult {
  direction: BridgeDirection;
  from: string;
  to: string;
  amount: string;
  sourceSignature: string;
  sourceExplorerUrl: string;
  messageId: string | null;
  destinationDomain: number;
  delivered: boolean;
  destinationTx: string | null;
  /** Collateral available on the destination when the transfer was signed (UI COOK); null when the
   *  preflight could not read it. */
  destinationCollateral: string | null;
  /** Cookie→Solana only: the recipient's SPL COOK account, and the tx that created it when this
   *  bridge had to. null on solana→cookie or when it could not be read. */
  recipientTokenAccount: RecipientTokenAccountInfo | null;
  note: string;
}

export async function bridge(args: {
  direction: BridgeDirection;
  to?: string;
  amount: string | number;
  waitForDelivery?: boolean;
  /** cookie-to-solana: create the recipient's SPL COOK account from this wallet when they have none
   *  (default). Set false to rely on the warp route's own ATA payer instead — which is refused when
   *  that payer is provably dry, since the transfer would hang. */
  createRecipientAccount?: boolean;
}): Promise<BridgeResult> {
  if (args.direction !== "cookie-to-solana" && args.direction !== "solana-to-cookie") {
    throw new CookieMcpError(
      `invalid direction "${args.direction}"`,
      "use 'cookie-to-solana' or 'solana-to-cookie'",
    );
  }
  const { keypair } = requireWallet();
  const sender = keypair.publicKey;
  const route = resolveRoute(args.direction);

  // Recipient on the destination chain. Both chains are SVM and use the same keypair, so default to
  // bridging to your own wallet on the other side.
  const to = args.to ?? ownPublicKey()!;
  let recipient32: Uint8Array;
  try {
    recipient32 = recipientTo32(to);
  } catch {
    throw new CookieMcpError(
      `invalid recipient: ${to}`,
      "pass the destination-chain recipient as a base58 pubkey",
    );
  }

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, route.sourceDecimals);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `the source side of this route has ${route.sourceDecimals} decimals`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive amount");
  }

  // Preflight the far side's collateral before anything is signed (see the section above).
  const destinationCollateral = await assertDestinationCollateral(route, amountRaw);
  // Make sure a first-time recipient actually has somewhere to receive on Solana (see above). Runs
  // before the dispatch, so a failure here leaves nothing locked.
  const recipientTokenAccount = await ensureRecipientTokenAccount(
    route,
    new PublicKey(recipient32),
    keypair,
    { create: args.createRecipientAccount !== false },
  );

  const uniqueMsg = Keypair.generate();
  const transferIx = await buildTransferRemoteIx(
    route,
    sender,
    uniqueMsg.publicKey,
    recipient32,
    amountRaw,
  );
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT });

  const { blockhash, lastValidBlockHeight } =
    await route.sourceConn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: sender, blockhash, lastValidBlockHeight })
    .add(computeIx)
    .add(transferIx);
  // Ephemeral signer first (replay protection), then the wallet.
  tx.partialSign(uniqueMsg);
  tx.partialSign(keypair);

  // Simulate defensively: the Cookie Chain Agave fork can reject the rich simulate call even for a
  // valid tx (a known fork quirk), so a *thrown* simulation is treated as "couldn't simulate" and we
  // proceed. A simulation that actually runs and returns an error is surfaced.
  try {
    const sim = await route.sourceConn.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
      if (/BlockhashNotFound|blockhash/i.test(blob) && route.sourceChain === "cookie") {
        throw new CookieMcpError(
          "bridge simulation failed: blockhash not found",
          "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
        );
      }
      throw new CookieMcpError(
        `bridge simulation failed${logs.length ? `: ${logs.slice(-3).join(" | ")}` : ""}`,
        route.sourceChain === "solana"
          ? "check the wallet's SPL COOK balance and that it holds SOL for fees"
          : "check the wallet's COOK balance (amount + gas + interchain-gas payment)",
      );
    }
  } catch (e) {
    if (e instanceof CookieMcpError) throw e;
    // Fork rejected the simulate call itself — not an error; proceed to send.
  }

  const sourceSignature = await route.sourceConn.sendRawTransaction(tx.serialize());
  // A confirm timeout here does not mean the transfer failed — the dispatch may still land and the
  // relayer would then deliver it. Retrying would bridge the amount twice, so surface the signature
  // (on the SOURCE chain's explorer) instead of a bare timeout.
  await confirmSent(
    route.sourceConn,
    { signature: sourceSignature, blockhash, lastValidBlockHeight },
    "bridge",
    { explorerUrl: route.sourceExplorerTxUrl(sourceSignature) },
  );

  // Extract the Hyperlane message id from the dispatch tx logs. getTransaction can lag confirmation on
  // public RPCs (esp. Solana mainnet-beta), returning null for a few seconds after the tx confirms —
  // retry a few times before giving up (the transfer still dispatched; it's recoverable from the sig).
  let messageId: string | null = null;
  for (let attempt = 0; attempt < 6 && !messageId; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2_500));
    try {
      const confirmed = await route.sourceConn.getTransaction(sourceSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      messageId = messageIdFromLogs(confirmed?.meta?.logMessages);
    } catch {
      /* transient — retry */
    }
  }

  let delivered = false;
  let destinationTx: string | null = null;
  if (args.waitForDelivery && messageId) {
    // Bounded poll (~3 min). Delivery is relayer-paced and varies (often <1 min, sometimes longer,
    // especially cookie→solana); a timeout here is NOT a failure — the transfer is still in flight.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const d = await isDelivered(route.destConn, route.destMailbox, messageId);
      if (d.delivered) {
        delivered = true;
        destinationTx = d.destinationTx;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  const note = delivered
    ? "delivered on the destination chain"
    : !messageId
      ? "dispatched — could not read the message id from logs; check the source tx on the explorer"
      : args.waitForDelivery
        ? "dispatched, but not delivered within the ~3 min wait window — this is normal (relayer-paced), " +
          "NOT a failure; re-check delivery with bridge_status using the messageId below"
        : "dispatched — a relayer delivers on the destination chain in a few minutes; check with bridge_status";

  return {
    direction: args.direction,
    from: sender.toBase58(),
    to,
    amount: String(args.amount),
    sourceSignature,
    sourceExplorerUrl: route.sourceExplorerTxUrl(sourceSignature),
    messageId,
    destinationDomain: route.destinationDomain,
    delivered,
    destinationTx,
    destinationCollateral,
    recipientTokenAccount,
    note,
  };
}

export interface BridgeStatusResult {
  messageId: string;
  direction: BridgeDirection;
  delivered: boolean;
  destinationTx: string | null;
  destinationExplorerUrl: string | null;
}

/** Check whether a bridged message has been delivered on the destination chain. A read-only lookup
 *  that needs only the destination mailbox — no warp program id / wallet required. */
export async function bridgeStatus(args: {
  messageId: string;
  direction: BridgeDirection;
}): Promise<BridgeStatusResult> {
  const toSolana = args.direction === "cookie-to-solana";
  const destConn = toSolana ? getSolanaConnection() : getConnection();
  const destMailbox = parsePk(
    toSolana ? BRIDGE.solana.mailbox : BRIDGE.cookie.mailbox,
    "destination mailbox",
  );
  const { delivered, destinationTx } = await isDelivered(destConn, destMailbox, args.messageId);
  // Destination explorer is the opposite chain's explorer.
  const destExplorer = toSolana ? solanaExplorerTxUrl : explorerTxUrl;
  return {
    messageId: args.messageId.toLowerCase(),
    direction: args.direction,
    delivered,
    destinationTx,
    destinationExplorerUrl: destinationTx ? destExplorer(destinationTx) : null,
  };
}
