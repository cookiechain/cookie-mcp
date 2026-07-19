// Shared liquidity-tx sender: confirmed-commitment blockhash, simulate-before-send (with the
// finalization-stall hint), sign, send, confirm. Used by every LP venue (DAMM / CLMM / SAMM) so they
// all get the same safety path. Extracted from damm.ts.
import { Keypair, Transaction, type Connection, type Signer } from "@solana/web3.js";

import { CookieMcpError } from "../errors";

/** Sign, simulate, send, and confirm a legacy Transaction. Signer[0] is the fee payer. */
export async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Signer[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        "simulation failed: blockhash not found",
        "Cookie Chain finalization may be stalled — check chain_health; retry",
      );
    }
    throw new CookieMcpError(
      `simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "check your balances and the pool state; the transaction was not sent",
    );
  }
  tx.sign(...(signers as Keypair[]));
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

export const LP_NOTE = "verify the result on cookiescan.io";
