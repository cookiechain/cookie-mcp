// Shared liquidity-tx sender: confirmed-commitment blockhash, simulate-before-send (with the
// finalization-stall hint), sign, send, confirm. Used by every LP venue (DAMM / CLMM / BAMM) so they
// all get the same safety path. Extracted from damm.ts.
import { Keypair, Transaction, type Connection, type Signer } from "@solana/web3.js";

import { confirmSent } from "../confirm";
import { CookieMcpError } from "../errors";
import { signWithCosigners, type TxSigner } from "../signer";

/**
 * Simulate, sign, send, and confirm a legacy Transaction. `signer` is the wallet and fee payer;
 * `cosigners` are ephemeral keypairs (position mints, transfer authorities) that sign first. `what`
 * names the action for the "sent but unconfirmed" warning — pass it so a retry-unsafe timeout is
 * unambiguous. With an external signer this stops after the simulation with `SignatureRequired`.
 */
export async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  signer: TxSigner,
  cosigners: Signer[],
  what = "transaction",
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
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
  await signWithCosigners(signer, tx, cosigners as Keypair[], {
    what,
    blockhash,
    lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
  });
  const signature = await conn.sendRawTransaction(tx.serialize());
  return confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, what);
}

export const LP_NOTE = "verify the result on cookiescan.io";
