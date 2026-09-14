// transfer — send native COOK (SystemProgram) or an SPL/Token-2022 token (idempotent ATA create +
// transfer-checked), with an optional SPL Memo. Same safety as trade: simulate-before-send on confirmed.
import { PublicKey, Transaction, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

import { COOK_MINT, COOK_SYMBOL, COOK_DECIMALS, MEMO_PROGRAM_ID, explorerTxUrl } from "./config";
import { confirmSent } from "./confirm";
import { resolveWallet } from "./domains";
import { CookieMcpError } from "./errors";
import { fetchToken } from "./cookiescan";
import { getConnection } from "./rpc";
import { requireWallet } from "./wallet";
import { rawToUi, uiToRaw } from "./format";

export function parsePubkey(addr: string, label: string): PublicKey {
  try {
    return new PublicKey(addr);
  } catch {
    throw new CookieMcpError(`invalid ${label} address: ${addr}`, "pass a valid base58 pubkey");
  }
}

/** A transfer is "native" (SystemProgram COOK) when no mint is given or it is the COOK mint. */
export function isNativeTransfer(mint?: string): boolean {
  return !mint || mint === COOK_MINT;
}

/**
 * The longest memo a transfer carries, in UTF-8 bytes. The Memo program itself only requires valid
 * UTF-8; the cap keeps the instruction well inside the transaction size limit next to a token
 * transfer with an account create.
 */
export const MAX_MEMO_BYTES = 566;

/**
 * An SPL Memo instruction signed by the sender, so the memo is attributable to the wallet that paid.
 * Payment-request and invoicing apps on Cookie Chain read the memo back out of the transaction to
 * match a transfer to a request, which is why a transfer can carry one.
 */
export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  const data = Buffer.from(memo, "utf8");
  if (memo.trim().length === 0) {
    throw new CookieMcpError("memo is empty", "omit `memo`, or pass the text to record");
  }
  if (data.length > MAX_MEMO_BYTES) {
    throw new CookieMcpError(
      `memo is ${data.length} bytes; the limit is ${MAX_MEMO_BYTES}`,
      "shorten the memo",
    );
  }
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data,
  });
}

export interface TransferResult {
  signature: string;
  explorerUrl: string;
  to: string;
  /** The `.cook` name the recipient was given as, when one was used. */
  toName?: string;
  mint: string;
  symbol: string | null;
  amount: string;
  /** The memo written alongside the transfer, when one was given. */
  memo?: string;
}

export async function transfer(args: {
  to: string;
  mint?: string;
  amount: string | number;
  memo?: string;
}): Promise<TransferResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const from = keypair.publicKey;
  // Built first so a bad memo fails before any RPC round trip.
  const memoIx = args.memo !== undefined ? memoInstruction(args.memo, from) : null;
  // `to` may be a base58 address or a `.cook` name; an address costs no extra round trip.
  const recipient = await resolveWallet(args.to, "recipient");
  const to = recipient.pubkey;
  const isNative = isNativeTransfer(args.mint);

  const tx = new Transaction();
  let mint = COOK_MINT;
  let symbol: string | null = COOK_SYMBOL;

  if (isNative) {
    let lamports: bigint;
    try {
      lamports = uiToRaw(args.amount, COOK_DECIMALS);
    } catch {
      throw new CookieMcpError(`invalid amount "${args.amount}"`, "COOK has up to 9 decimals");
    }
    if (lamports <= 0n) {
      throw new CookieMcpError("amount must be greater than 0", "pass a positive amount");
    }
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) }));
  } else {
    mint = args.mint!;
    const mintPk = parsePubkey(mint, "mint");
    // The mint's owner tells us TOKEN vs TOKEN-2022; decimals come with the parsed mint.
    const acct = await conn.getParsedAccountInfo(mintPk);
    const parsed = acct.value?.data;
    if (!acct.value || !parsed || !("parsed" in parsed)) {
      throw new CookieMcpError(`mint ${mint} not found on-chain`, "check the mint address");
    }
    const tokenProgram = acct.value.owner;
    const decimals: number = (parsed.parsed as { info: { decimals: number } }).info.decimals;

    const registryToken = await fetchToken(mint);
    symbol = registryToken?.metadata?.symbol ?? null;

    let rawAmount: bigint;
    try {
      rawAmount = uiToRaw(args.amount, decimals);
    } catch {
      throw new CookieMcpError(
        `invalid amount "${args.amount}"`,
        `${symbol ?? mint} has up to ${decimals} decimals`,
      );
    }
    if (rawAmount <= 0n) {
      throw new CookieMcpError("amount must be greater than 0", "pass a positive amount");
    }

    const sourceAta = getAssociatedTokenAddressSync(mintPk, from, false, tokenProgram);
    const destAta = getAssociatedTokenAddressSync(mintPk, to, true, tokenProgram);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(from, destAta, to, mintPk, tokenProgram),
      createTransferCheckedInstruction(
        sourceAta,
        mintPk,
        destAta,
        from,
        rawAmount,
        decimals,
        [],
        tokenProgram,
      ),
    );
  }

  if (memoIx) tx.add(memoIx);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        "transfer simulation failed: blockhash not found",
        "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
      );
    }
    throw new CookieMcpError(
      `transfer simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "check the recipient, balance, and that the wallet holds enough COOK for fees",
    );
  }

  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, "transfer");

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    to: to.toBase58(),
    ...(recipient.name ? { toName: recipient.name } : {}),
    mint,
    symbol,
    amount: isNative
      ? rawToUi(uiToRaw(args.amount, COOK_DECIMALS), COOK_DECIMALS)
      : String(args.amount),
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
  };
}
