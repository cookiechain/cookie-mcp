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
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  BRIDGE,
  COOKIE_DOMAIN,
  COOKIE_WARP_PROGRAM_ID,
  SOLANA_DOMAIN,
  SOLANA_WARP_PROGRAM_ID,
  explorerTxUrl,
  solanaExplorerTxUrl,
} from "./config";
import { CookieMcpError } from "./errors";
import { getConnection, getSolanaConnection } from "./rpc";
import { requireWallet, assertWithinSpendCap, ownPublicKey } from "./wallet";
import { uiToRaw } from "./format";

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
  note: string;
}

export async function bridge(args: {
  direction: BridgeDirection;
  to?: string;
  amount: string | number;
  waitForDelivery?: boolean;
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

  const amountUi = Number(args.amount);
  // COOK is 1:1 across the bridge, so it is always valued at 1 COOK for the spend cap.
  assertWithinSpendCap(amountUi, 1);
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
  await route.sourceConn.confirmTransaction(
    { signature: sourceSignature, blockhash, lastValidBlockHeight },
    "confirmed",
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
