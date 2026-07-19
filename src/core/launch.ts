// deploy_token — launch a token on the Cookiebox dynamic bonding curve: grind a vanity mint (suffix
// "box") → upload metadata → build the launch ix → simulate → sign (payer + mint) → send → confirm.
// Non-custodial; requires a wallet.
import { Transaction, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

import { COOK_MINT, explorerTxUrl, explorerTokenUrl, explorerAddressUrl } from "./config";
import { CookieMcpError } from "./errors";
import { getConnection } from "./rpc";
import { requireWallet } from "./wallet";
import { grindVanityMint } from "./launch/vanity";
import { uploadMetadata } from "./launch/metadata";
import { buildLaunchIx, DBC_INIT_POOL_CU, DBC_TOKEN_DECIMALS } from "./launch/dbc";

const VANITY_SUFFIX = "box";
const COOKIEBOX_APP_URL = "https://cookiebox.app";

export interface DeployTokenResult {
  mint: string;
  vanity: boolean;
  pool: string;
  signature: string;
  decimals: number;
  name: string;
  symbol: string;
  metadataUri: string;
  imageUrl: string;
  links: { explorerTx: string; token: string; pool: string; cookiebox: string };
}

export async function deployToken(args: {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  initialBuyCook?: number;
}): Promise<DeployTokenResult> {
  const { keypair } = requireWallet();

  const name = args.name?.trim();
  const symbol = args.symbol?.trim();
  if (!name) throw new CookieMcpError("name is required", "pass a non-empty token name");
  if (!symbol) throw new CookieMcpError("symbol is required", "pass a non-empty ticker");
  if (symbol.length > 10) {
    throw new CookieMcpError("symbol is too long", "use a ticker of 10 characters or fewer");
  }
  // The pool doesn't exist until this tx lands, so a launch-time pre-buy would need a second DBC swap.
  if (args.initialBuyCook != null) {
    throw new CookieMcpError(
      "initialBuyCook (launch-time pre-buy) is not supported yet",
      "launch first, then call `trade` COOK → the new mint once it's indexed",
    );
  }

  const conn = getConnection();
  const payer = keypair.publicKey;

  const { keypair: mintKp, address: mint, vanity } = grindVanityMint(VANITY_SUFFIX);

  // Metadata upload uses the mint as its storage key, so grind the mint first.
  const { uri, imageUrl } = await uploadMetadata(keypair, {
    mint,
    name,
    symbol,
    description: args.description,
    imageUrl: args.imageUrl,
  });

  const { ix, pool } = buildLaunchIx({
    payer,
    baseMint: mintKp.publicKey,
    quoteMint: new PublicKey(COOK_MINT),
    name,
    symbol,
    uri,
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: DBC_INIT_POOL_CU }),
    ix,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        "launch simulation failed: blockhash not found",
        "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
      );
    }
    throw new CookieMcpError(
      `launch simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "ensure the wallet holds enough COOK for rent + fees, and that name/symbol/uri are valid",
    );
  }

  tx.sign(keypair, mintKp);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  return {
    mint,
    vanity,
    pool: pool.toBase58(),
    signature,
    decimals: DBC_TOKEN_DECIMALS,
    name,
    symbol: symbol.toUpperCase(),
    metadataUri: uri,
    imageUrl,
    links: {
      explorerTx: explorerTxUrl(signature),
      token: explorerTokenUrl(mint),
      pool: explorerAddressUrl(pool.toBase58()),
      cookiebox: `${COOKIEBOX_APP_URL}/token/${mint}`,
    },
  };
}
