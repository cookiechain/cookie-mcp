// The curve-sell VAULT — how CookieBox's maker fee reaches a bonding-curve sell.
//
// `sell_authorized` pays whatever account the authorization pinned, and the limit-order program
// never sees the sale. So the authorization pins a vault the program owns — the wCOOK associated
// account of PDA `["curve_sell", pool, maker]` — and the program's `settle_curve_sell` pays it out:
// `Fee.maker_fee` to the fee vault, the rest to the maker's WALLET as native COOK, unwrapped through
// a scratch `["payout", vault]` account the program creates and closes inside the instruction
// (fibanachos/limit-order#2). The maker needs no token account.
// The floor therefore applies to what reaches the vault, BEFORE the fee, exactly like a plain
// order's `taking_amount`: priced at P, the order fills once the curve pays P and the maker nets
// P minus the fee. The keeper refuses an authorization signed after the switch that pins anything
// else, so a payout that is not the vault is a placement that will never fill.
//
// Shared by the placement (`curveOrders.ts`) and the revoke (`limitOrders.ts`) so neither imports
// the other for it. The instruction is hand-built and pinned to the vendored IDL by a test.
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { COOK_MINT, PROGRAM_IDS } from "./config";

// Read from config here rather than `limitOrders.ts` so that module can import this one.
const LIMIT_ORDER_PROGRAM_ID = new PublicKey(PROGRAM_IDS.limitOrder);
const WCOOK = new PublicKey(COOK_MINT);

/** `sha256("global:settle_curve_sell")[..8]` — pinned against the vendored IDL by a test. */
export const SETTLE_CURVE_SELL_DISCRIMINATOR = Uint8Array.from([139, 7, 151, 172, 180, 62, 75, 51]);

/** `["fee"]` — the `Fee` singleton, which is also the authority over the program's fee accounts. */
export function limitOrderFeePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("fee")], LIMIT_ORDER_PROGRAM_ID)[0];
}

/** The PDA that owns a curve sell's vault. Signs for it; holds nothing. */
export function curveSellAuthorityPda(pool: PublicKey, maker: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve_sell"), pool.toBuffer(), maker.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

/** The scratch wrapped account a settlement unwraps the maker's share through; one per vault. */
export function curveSellPayoutPda(vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("payout"), vault.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

/** The account a curve sell's authorization pins as its payout. */
export function curveSellVault(pool: PublicKey, maker: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    WCOOK,
    curveSellAuthorityPda(pool, maker),
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** The vault is an ordinary ATA: whoever pays creates it, idempotently, before the approval. */
export function buildCreateCurveSellVaultIx(
  payer: PublicKey,
  pool: PublicKey,
  maker: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    curveSellVault(pool, maker),
    curveSellAuthorityPda(pool, maker),
    WCOOK,
    TOKEN_PROGRAM_ID,
  );
}

/** True when this authorization pays the vault, i.e. pays the maker fee and needs settling. */
export function isCurveSellVaultPayout(args: {
  pool: PublicKey;
  owner: PublicKey;
  payoutAccount: PublicKey;
}): boolean {
  return args.payoutAccount.equals(curveSellVault(args.pool, args.owner));
}

/**
 * `settle_curve_sell(close)`. `close = false` is permissionless (the keeper appends it to a fill);
 * `close = true` is the maker's cancel tail after `revoke_position_sale`: settles what is left and
 * closes the vault, rent to the maker. The program refuses a close from anyone else. The maker's
 * share arrives as lamports in the wallet; the settler fronts the scratch account's rent and gets
 * it back in the same instruction.
 */
export function buildSettleCurveSellIx(args: {
  payer: PublicKey;
  maker: PublicKey;
  pool: PublicKey;
  close: boolean;
}): TransactionInstruction {
  const { payer, maker, pool } = args;
  const data = Buffer.alloc(9);
  data.set(SETTLE_CURVE_SELL_DISCRIMINATOR, 0);
  data[8] = args.close ? 1 : 0;
  const fee = limitOrderFeePda();
  const vault = curveSellVault(pool, maker);
  return new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: maker, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: curveSellAuthorityPda(pool, maker), isSigner: false, isWritable: false },
      { pubkey: WCOOK, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: curveSellPayoutPda(vault), isSigner: false, isWritable: true },
      { pubkey: fee, isSigner: false, isWritable: false },
      {
        pubkey: getAssociatedTokenAddressSync(
          WCOOK,
          fee,
          true,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
