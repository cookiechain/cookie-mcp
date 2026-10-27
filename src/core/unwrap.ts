// unwrap_cook — turn the wallet's wrapped COOK (wCOOK, the SPL account of the native mint) back into
// native COOK by closing that account: its whole balance plus its rent comes back to the wallet.
//
// wCOOK piles up where a venue pays out in it and does not unwrap: launchpad referral earnings, an
// NFT sell-back, a swap run with `unwrapCook: false`. Built here, not by a venue API — it is one
// stock instruction on an account we own — and still simulated within a budget before signing.
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  unpackAccount,
} from "@solana/spl-token";
import { Transaction, type AccountInfo, type PublicKey } from "@solana/web3.js";

import { COOK_DECIMALS, COOK_SYMBOL, explorerTxUrl } from "./config";
import { confirmSent } from "./confirm";
import { CookieMcpError } from "./errors";
import { rawToUi } from "./format";
import { getConnection } from "./rpc";
import { nativeBudget, simulateWithinBudget } from "./spendGuard";
import { requireSigner } from "./wallet";

/** What closing the wallet's wCOOK account returns: the wrapped balance and the account's rent. Pure. */
export function unwrapPlan(
  owner: PublicKey,
  ata: PublicKey,
  info: AccountInfo<Buffer> | null,
): { wrapped: bigint; rent: bigint } {
  if (!info) {
    throw new CookieMcpError(
      "this wallet holds no wrapped COOK",
      "nothing to unwrap; get_balance lists wCOOK under the native mint when there is some",
    );
  }
  const acct = unpackAccount(ata, info);
  if (!acct.mint.equals(NATIVE_MINT) || !acct.owner.equals(owner)) {
    throw new CookieMcpError(
      "the wallet's wrapped-COOK address does not hold its own wCOOK account",
      "nothing was sent",
    );
  }
  return { wrapped: acct.amount, rent: BigInt(info.lamports) - acct.amount };
}

export async function unwrapCook() {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const { wrapped, rent } = unwrapPlan(owner, ata, await conn.getAccountInfo(ata, "confirmed"));

  const tx = new Transaction().add(createCloseAccountInstruction(ata, owner, owner));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  // Native value counts the wrapped balance too, so an unwrap moves nothing: only the fee may leave.
  const sim = await simulateWithinBudget(conn, tx, owner, nativeBudget(0n), {
    what: "unwrap",
    source: "local",
  });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw new CookieMcpError(
      `unwrap simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "nothing was sent; check the wallet holds enough COOK for the fee",
    );
  }

  const cook = (raw: bigint) => rawToUi(raw, COOK_DECIMALS);
  await signer.signTransaction(tx, {
    what: "unwrap",
    blockhash,
    lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    summary: { unwrapCook: cook(wrapped), rentBackCook: cook(rent) },
  });
  const signature = await conn.sendRawTransaction(tx.serialize());
  await confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, "unwrap");
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    unwrapped: { amount: cook(wrapped), symbol: COOK_SYMBOL },
    rentReturned: { amount: cook(rent), symbol: COOK_SYMBOL },
    note: "The wrapped-COOK account is closed; any tool that pays in wCOOK reopens it when needed.",
  };
}
