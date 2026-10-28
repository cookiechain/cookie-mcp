// Pre-sign check for a MomoSwap NFT launchpad build, held to the program's own IDL.
//
// `simulateWithinBudget` (spendGuard.ts) bounds what a build may do to OUR accounts: how much COOK
// leaves, which item leaves, no delegate or owner change. It cannot tell a sell from a
// `cancel_listing`, or notice a build that names a different collection, because neither shows up
// as a balance change. This is the part that knows the program — a port of the MomoSwap frontend's
// `nftTxVerify.ts`, which signs the same API's builds:
//
//   - **Which instructions a kind may call, in order** (`KIND_INSTRUCTIONS`). Anything else from the
//     NFT program, in any position, is refused — `list_on_marketplace` above all.
//   - **The IDL's account list.** The count, every signer / writable flag, every fixed address and
//     every PDA, re-derived from the instruction's own slots. A build for another program version has
//     a different count and is refused before anything else is compared.
//   - **What only we know.** Our wallet fills the slot that authorises the instruction, the
//     collection is the one asked for, and an item we hold is the one asked for.
//   - **The stock instructions around it.** A compute-unit LIMIT (never a price: a price is a fee
//     drain), idempotent ATA creates paid by us, the native wrap for a mint, the proceeds unwrap for
//     a claim. No other System or Token call: either could move our funds in the same signature.
//
// Like the frontend's, this bounds the TOP-LEVEL instruction list. What happens inside the program is
// the program's to enforce; this makes sure it is asked to do what the user asked, to the accounts the
// user asked about. The vendored IDL (`src/idl/momo_nft_launchpad.json`) is anchor-launchpad-momoswap
// main `918d12b` (#108, #110–#116; upstream sha256 `ca86a51f…`), Prettier-formatted; its content hash
// is pinned in `verify.test.ts`. It is a superset of the one the backend carries (momoswap-backend#333,
// anchor `79973de`): #115 and #116 add `forfeit_creator_escrow`, account fields and errors 6060–6062,
// and change no instruction cookie-mcp signs. Refresh it with the backend's when the program changes.
//
// That IDL is ahead of the deployed `momoDc2L…` binary, and the backend builds for whichever one is
// live, so a create is accepted in both shapes for one release (`LEGACY_SEED_PATHS`, and the royalty
// partner after `create_collection`'s accounts, which the live binary ignores).
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, type Transaction } from "@solana/web3.js";

import { PROGRAM_IDS } from "../config";
import { CookieMcpError } from "../errors";
import nftIdl from "../../idl/momo_nft_launchpad.json" with { type: "json" };

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export const NFT_PROGRAM_ID = PROGRAM_IDS.momoNftLaunchpad;

type IdlSeed =
  | { kind: "const"; value: number[] }
  | { kind: "account"; path: string; account?: string }
  | { kind: "arg"; path: string };

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
}

interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
}

const INSTRUCTIONS = (nftIdl as { instructions: IdlInstruction[] }).instructions;
const TYPES = (
  nftIdl as unknown as {
    types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[] } }[];
  }
).types;

/**
 * PDA seeds a program upgrade changed, accepted as they were for ONE release so the program, the
 * backend and cookie-mcp can switch in any order. Per instruction and account: a seed path as the IDL
 * has it now → as it was. TEMPORARY, like the frontend's `LEGACY_SEED_PATHS` (momoswap-frontend#449).
 *
 * anchor-launchpad-momoswap#111 moved the collection NFT from the creator's token account to the
 * collection authority's: the backend (momoswap-backend#333) builds the creator's ATA until it sees the
 * upgraded binary. Remove this entry once #111 is deployed on `momoDc2L…` and `/v1/nft/status` reports
 * `collectionNftHolder: "program"`.
 */
const LEGACY_SEED_PATHS: Readonly<Record<string, Record<string, Record<string, string>>>> = {
  create_collection: { collection_token_account: { collection_authority: "creator" } },
};

/** The default pubkey: the program's "no royalty partner". */
const NO_PARTNER = "11111111111111111111111111111111";

/** The kinds of build cookie-mcp signs on this program. */
export type NftKind =
  | "mint"
  | "request-mint"
  | "sell"
  | "redeem"
  | "wind-down"
  | "claim"
  | "create"
  | "reveal"
  | "settle"
  | "refund"
  | "graduate";

/** For each kind, the program instructions its build may contain, in order. */
export const KIND_INSTRUCTIONS: Readonly<Record<NftKind, readonly (readonly string[])[]>> = {
  // A curve mint, or `buy_returned` when the pool holds a unit sold back earlier (same payment legs).
  mint: [["buy_nft"], ["buy_returned"]],
  // After a target graduation: the buyer escrows, a keeper settles a random item, or refunds on expiry.
  "request-mint": [["request_mint"]],
  sell: [["sell_nft"]],
  redeem: [["redeem_floor"]],
  // The chain marks a failed drop live until someone closes it, and only a closed drop winds down, so
  // the first holder's refund may close it in the same transaction.
  "wind-down": [["redeem_wind_down"], ["close_collection", "redeem_wind_down"]],
  claim: [["claim_creator_proceeds"]],
  // One transaction, so a collection never exists without its vaults. A target is set in the same
  // transaction, before any buy can exist — and only when the creator asked for one (see below).
  create: [
    ["create_collection", "init_vaults"],
    ["create_collection", "init_vaults", "set_graduation_target"],
  ],
  reveal: [["reveal"]],
  // Upkeep anyone may send. The queue head need not be ours: the program pays its item or its refund
  // to the request's own buyer, whoever signs. A refund first creates that buyer's wCOOK account
  // (idempotent, paid by us) so a buyer who closed theirs cannot hold up the queue.
  settle: [["settle_mint"]],
  refund: [["refund_mint"]],
  graduate: [["graduate"]],
};

/** Kinds that wrap native COOK into the wallet's wCOOK account for the payment. */
const WRAPPING_KINDS: readonly NftKind[] = ["mint", "request-mint"];
/** Kinds whose proceeds may be unwrapped by closing the wallet's wCOOK account, last. */
const UNWRAPPING_KINDS: readonly NftKind[] = ["claim"];

/** The account in each instruction that authorises it: the one our wallet must fill. */
const WALLET_SLOT: Readonly<Record<string, string>> = {
  buy_nft: "buyer",
  buy_returned: "buyer",
  request_mint: "buyer",
  sell_nft: "seller",
  redeem_floor: "holder",
  redeem_wind_down: "holder",
  close_collection: "signer",
  claim_creator_proceeds: "creator",
  create_collection: "creator",
  init_vaults: "payer",
  set_graduation_target: "creator",
  reveal: "creator",
  settle_mint: "settler",
  refund_mint: "caller",
  graduate: "signer",
};

/** What we decided before the API answered. */
export interface NftExpectation {
  wallet: string;
  /** The drop asked about. Absent only for a create, whose build introduces the collection mint. */
  collectionMint?: string;
  /** The item a sell / redeem acts on — one we hold and named. */
  nftMint?: string;
  /** Create: the graduation target the creator chose (raw), or null/absent for sell-out only. */
  graduationTarget?: bigint | null;
  /**
   * Mint / request-mint: the user's approved ALL-IN spend (price + fee), the most `max_cost` may be.
   * From anchor-launchpad-momoswap#112 the program bounds price + fee by `max_cost` and the backend
   * sends that all-in figure (momoswap-backend#333, at most `maxSpendRaw`). Against the binary deployed
   * before #112 it bounds the price alone, so the fee can still ride on top of it — never add the fee
   * here: that would refuse every all-in build.
   */
  maxCost?: bigint;
  /**
   * Create: the royalty partner and share the creator chose (null / 0: none). When set, the build's
   * `CollectionParams` must carry exactly these.
   */
  royaltyPartner?: string | null;
  partnerShareBps?: number;
  /** Sell: the least `min_proceeds` may accept. */
  minProceeds?: bigint;
}

function refuse(kind: NftKind, detail: string): CookieMcpError {
  return new CookieMcpError(
    `refusing to sign this NFT ${kind}: the launchpad's build does not match the request (${detail})`,
    "nothing was signed or sent; retry, and report this if it persists — it can mean the API is " +
      "misbehaving, or that the NFT launchpad program changed and cookie-mcp needs an update",
  );
}

function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function u64At(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i] ?? 0);
  return v;
}

/** Bytes a fixed-size argument takes in Anchor's encoding. Null: variable (a vec, a struct). */
function argSize(type: unknown): number | null {
  const fixed: Record<string, number> = {
    u8: 1,
    bool: 1,
    u16: 2,
    u32: 4,
    u64: 8,
    i64: 8,
    pubkey: 32,
  };
  if (typeof type === "string") return fixed[type] ?? null;
  const arr = (type as { array?: [unknown, number] })?.array;
  return arr && arr[0] === "u8" ? arr[1] : null;
}

/** An argument's bytes in the instruction data: after the discriminator and every argument before it. */
function argBytes(spec: IdlInstruction, data: Uint8Array, name: string): Uint8Array {
  let offset = 8;
  for (const a of spec.args) {
    const size = argSize(a.type);
    if (size === null) throw new Error(`${spec.name}: ${name} sits after a variable-size argument`);
    if (a.name === name) return data.slice(offset, offset + size);
    offset += size;
  }
  throw new Error(`${spec.name} has no argument ${name}`);
}

/**
 * Borsh-decode an instruction's single struct argument by its IDL field list, each field as a canonical
 * string (integers in decimal, bools as true/false, byte arrays in hex, pubkeys in base58). Refuses
 * data cut short, a field type this does not know, or bytes left over.
 */
function decodeStruct(
  spec: IdlInstruction,
  data: Uint8Array,
  where: string,
  no: (detail: string) => CookieMcpError,
): Map<string, string> {
  const typeName = (spec.args[0]?.type as { defined?: { name?: string } } | undefined)?.defined
    ?.name;
  const fields =
    spec.args.length === 1 ? TYPES.find((t) => t.name === typeName)?.type.fields : null;
  if (!fields) throw no(`${where} takes arguments cookie-mcp cannot read`);
  const out = new Map<string, string>();
  let o = 8;
  const take = (n: number, name: string): Uint8Array => {
    if (o + n > data.length) throw no(`${where}: its data ends inside ${name}`);
    o += n;
    return data.subarray(o - n, o);
  };
  const uint = (b: Uint8Array): bigint => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);
  const ints: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8 };
  for (const f of fields) {
    const t = f.type;
    if (t === "string") {
      const raw = take(Number(uint(take(4, f.name))), f.name);
      out.set(f.name, Buffer.from(raw).toString("utf8"));
    } else if (typeof t === "string" && ints[t]) {
      out.set(f.name, uint(take(ints[t]!, f.name)).toString());
    } else if (t === "i64") {
      out.set(f.name, BigInt.asIntN(64, uint(take(8, f.name))).toString());
    } else if (t === "bool") {
      const b = take(1, f.name)[0]!;
      if (b > 1) throw no(`${where}: ${f.name} is not a bool`);
      out.set(f.name, String(b === 1));
    } else if (t === "pubkey") {
      out.set(f.name, new PublicKey(take(32, f.name)).toBase58());
    } else {
      const arr = (t as { array?: [unknown, number] })?.array;
      if (!arr || arr[0] !== "u8")
        throw no(`${where}: ${f.name} has a type cookie-mcp cannot read`);
      out.set(f.name, Buffer.from(take(arr[1], f.name)).toString("hex"));
    }
  }
  if (o !== data.length) throw no(`${where} carries ${data.length - o} bytes after its arguments`);
  return out;
}

export function instructionByName(name: string): IdlInstruction | undefined {
  return INSTRUCTIONS.find((i) => i.name === name);
}

interface Call {
  at: number;
  spec: IdlInstruction;
  data: Uint8Array;
  accounts: { pubkey: string; signer: boolean; writable: boolean }[];
}

/**
 * Hold a decoded NFT build to `kind` and `known`. Throws a `CookieMcpError` on the first difference;
 * returns the program instructions it found, by name, so the caller can describe the build.
 */
export function assertNftBuild(tx: Transaction, kind: NftKind, known: NftExpectation): string[] {
  const no = (detail: string) => refuse(kind, detail);
  if (tx.feePayer?.toBase58() !== known.wallet) {
    throw no(`its fee payer is ${tx.feePayer?.toBase58() ?? "missing"}, not this wallet`);
  }
  const wcook = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(known.wallet)).toBase58();

  const calls: Call[] = [];
  const ixs = tx.instructions;
  ixs.forEach((ix, at) => {
    const programId = ix.programId.toBase58();
    const accounts = ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      signer: k.isSigner,
      writable: k.isWritable,
    }));
    const data = Uint8Array.from(ix.data);
    if (programId === NFT_PROGRAM_ID) {
      const spec = INSTRUCTIONS.find((s) => sameBytes(data, s.discriminator));
      if (!spec) throw no(`instruction ${at} is an NFT launchpad call cookie-mcp never signs`);
      calls.push({ at, spec, data, accounts });
      return;
    }
    const closing = calls.length > 0 && at === ixs.length - 1;
    assertStock(programId, accounts, data, at, kind, { wallet: known.wallet, wcook }, closing, no);
  });

  let allowed = KIND_INSTRUCTIONS[kind];
  // A create sets a graduation target only when the creator chose one: the build can neither add one
  // nobody asked for nor drop the one they did.
  if (kind === "create") {
    const withTarget = known.graduationTarget != null && known.graduationTarget > 0n;
    allowed = allowed.filter((seq) => seq.includes("set_graduation_target") === withTarget);
  }
  const names = calls.map((c) => c.spec.name);
  if (!allowed.some((seq) => seq.length === names.length && seq.every((n, i) => n === names[i]))) {
    throw no(
      `it calls ${names.length ? names.join(" + ") : "nothing"} on the NFT launchpad, expected ` +
        allowed.map((s) => s.join(" + ")).join(" or "),
    );
  }

  // Count first: a build for another layout passes a different number of accounts, and every slot
  // after the first difference would be compared against the wrong name. The one exception: a create
  // whose params name a royalty partner with a share passes that partner after the declared accounts
  // (anchor-launchpad-momoswap#110), checked below against the params.
  for (const c of calls) {
    const partnerSlot =
      c.spec.name === "create_collection" && c.accounts.length === c.spec.accounts.length + 1;
    if (c.accounts.length !== c.spec.accounts.length && !partnerSlot) {
      throw no(
        `instruction ${c.at} (${c.spec.name}) passes ${c.accounts.length} accounts; the program takes ${c.spec.accounts.length}`,
      );
    }
  }

  const slot = (c: Call, name: string): string | undefined => {
    const j = c.spec.accounts.findIndex((a) => a.name === name);
    return j < 0 ? undefined : c.accounts[j]!.pubkey;
  };

  // The collection mint: known for every kind but a create, which introduces it as a fresh signer.
  let collectionMint = known.collectionMint;
  for (const c of calls) {
    const fromBuild = slot(c, "collection_mint");
    if (fromBuild === undefined) continue;
    if (collectionMint !== undefined && fromBuild !== collectionMint) {
      throw no(
        `instruction ${c.at} (${c.spec.name}) is for collection ${fromBuild}, not ${collectionMint}`,
      );
    }
    collectionMint ??= fromBuild;
  }
  if (!collectionMint) throw no("it does not name the collection it is for");

  const keyBytes = (key: string, what: string): Uint8Array => {
    try {
      return new PublicKey(key).toBytes();
    } catch {
      throw no(`${what} is not an address: ${key}`);
    }
  };
  const seedBytes = (c: Call, seed: IdlSeed, owner: string): Uint8Array => {
    if (seed.kind === "const") return Uint8Array.from(seed.value);
    // The one field path the IDL uses: a PDA seeded by the collection ACCOUNT's own mint, which only the
    // collection mint we asked about can answer.
    if (seed.path === "collection.collection_mint")
      return keyBytes(collectionMint!, "the collection mint");
    if (seed.kind === "arg") {
      try {
        return argBytes(c.spec, c.data, seed.path);
      } catch (e) {
        throw no(e instanceof Error ? e.message : String(e));
      }
    }
    const key = slot(c, seed.path);
    if (key === undefined)
      throw no(`${c.spec.name}: ${owner} is seeded by an unknown account ${seed.path}`);
    return keyBytes(key, `${c.spec.name}.${seed.path}`);
  };

  for (const c of calls) {
    const { spec, accounts, at } = c;
    const where = `instruction ${at} (${spec.name})`;
    spec.accounts.forEach((want, j) => {
      const got = accounts[j]!;
      // An optional account left out is the program's own id in its slot (Anchor's `None`).
      if (want.optional && got.pubkey === NFT_PROGRAM_ID) return;
      if (want.signer && !got.signer) throw no(`${where}: ${want.name} has to sign`);
      if (want.writable && !got.writable) throw no(`${where}: ${want.name} has to be writable`);
      if (want.address && got.pubkey !== want.address) {
        throw no(`${where}: ${want.name} is ${got.pubkey}, expected ${want.address}`);
      }
      if (want.pda) {
        const seeds = want.pda.seeds.map((s) => seedBytes(c, s, want.name));
        const program = want.pda.program
          ? new PublicKey(seedBytes(c, want.pda.program, want.name))
          : new PublicKey(NFT_PROGRAM_ID);
        const [derived] = PublicKey.findProgramAddressSync(seeds, program);
        // TEMPORARY (see LEGACY_SEED_PATHS): the address the same seeds derived before the upgrade.
        const legacy = LEGACY_SEED_PATHS[spec.name]?.[want.name];
        const derivedBefore = legacy
          ? PublicKey.findProgramAddressSync(
              want.pda.seeds.map((s) =>
                seedBytes(
                  c,
                  s.kind === "account" && legacy[s.path] ? { ...s, path: legacy[s.path]! } : s,
                  want.name,
                ),
              ),
              program,
            )[0].toBase58()
          : undefined;
        if (derived.toBase58() !== got.pubkey && derivedBefore !== got.pubkey) {
          throw no(`${where}: ${want.name} is ${got.pubkey}, not the address its seeds derive`);
        }
      }
    });

    const authority = slot(c, WALLET_SLOT[spec.name] ?? "");
    if (authority !== known.wallet)
      throw no(`${where} is authorised by ${authority ?? "?"}, not this wallet`);

    // An item we hold (sell, redeem, wind-down) is the one asked about. A mint's `nft_mint` is a fresh
    // signer the build generates, and `buy_returned`'s is a pool unit the API picks; the program refuses
    // any unit that is not the collection's, and spendGuard requires one to arrive.
    const itemSlot = spec.accounts.find((a) => a.name === "nft_mint");
    if (itemSlot && !itemSlot.signer && !itemSlot.pda && spec.name !== "buy_returned") {
      if (!known.nftMint) throw no(`${where} acts on an item, but none was named`);
      if (slot(c, "nft_mint") !== known.nftMint) {
        throw no(
          `${where} acts on ${slot(c, "nft_mint")}, not the item asked for (${known.nftMint})`,
        );
      }
    }

    // The arguments only we can vouch for.
    if (spec.name === "set_graduation_target") {
      if (c.data.length !== 16)
        throw no(`${where} carries ${c.data.length} bytes of data, expected 16`);
      const target = u64At(c.data, 8);
      if (target !== known.graduationTarget) {
        throw no(
          `${where} sets a graduation target of ${target}, not the ${known.graduationTarget ?? "none"} asked for`,
        );
      }
    }
    if (spec.name === "create_collection") {
      const params = decodeStruct(spec, c.data, where, no);
      const partner = params.get("royalty_partner")!;
      const share = params.get("partner_share_bps")!;
      if (known.partnerShareBps !== undefined) {
        const wantPartner = known.royaltyPartner || NO_PARTNER;
        if (partner !== wantPartner || share !== String(known.partnerShareBps)) {
          throw no(
            `${where} names royalty partner ${partner} at ${share} bps, not the ${wantPartner} at ${known.partnerShareBps} bps asked for`,
          );
        }
      }
      const extra = accounts[spec.accounts.length];
      if (extra) {
        // anchor-launchpad-momoswap#110 reads the partner from the first remaining account to check it
        // is a plain wallet. Only a partner the program writes (set, with a non-zero share) is passed;
        // it is only read, and the build has no reason to make it sign or be written.
        if (partner === NO_PARTNER || share === "0") {
          throw no(
            `${where} passes an extra account ${extra.pubkey}, but names no royalty partner with a share`,
          );
        }
        if (extra.pubkey !== partner) {
          throw no(
            `${where} passes ${extra.pubkey} after its accounts, not the royalty partner ${partner}`,
          );
        }
        if (extra.signer || extra.writable) {
          throw no(`${where}: the royalty partner it passes has to be read-only`);
        }
      }
    }
    if (spec.name === "buy_nft" || spec.name === "buy_returned" || spec.name === "request_mint") {
      if (known.maxCost === undefined)
        throw no(`${where} has no approved spend to hold its max_cost to`);
      if (c.data.length < 16) throw no(`${where} carries no max_cost`);
      const maxCost = u64At(c.data, 8);
      if (maxCost > known.maxCost) {
        throw no(
          `${where} accepts a cost of up to ${maxCost}, more than the ${known.maxCost} approved`,
        );
      }
    }
    if (spec.name === "sell_nft" && known.minProceeds !== undefined) {
      const minProceeds = u64At(c.data, 8);
      if (minProceeds < known.minProceeds) {
        throw no(
          `${where} accepts proceeds as low as ${minProceeds}, below the ${known.minProceeds} asked for`,
        );
      }
    }
  }
  return names;
}

/** The stock instructions an NFT build may carry around its program call, each in one shape. */
function assertStock(
  programId: string,
  accounts: { pubkey: string }[],
  d: Uint8Array,
  at: number,
  kind: NftKind,
  own: { wallet: string; wcook: string },
  closing: boolean,
  no: (detail: string) => CookieMcpError,
): void {
  const acc = (i: number): string => accounts[i]?.pubkey ?? "";
  switch (programId) {
    case COMPUTE_BUDGET_PROGRAM:
      // SetComputeUnitLimit is tag 2 + a u32. SetComputeUnitPrice (tag 3) would be a priority fee.
      if (d.length === 5 && d[0] === 2) return;
      throw no(`instruction ${at} sets a compute budget other than a unit limit`);
    case ATA_PROGRAM:
      // CreateIdempotent, paid by us. A claim also creates its royalty partner's account, so the owner
      // is not pinned: creating an account costs the payer only its rent.
      if (d.length === 1 && d[0] === 1 && acc(0) === own.wallet) return;
      throw no(
        `instruction ${at} is an associated-token call other than an idempotent create we pay for`,
      );
    case SYSTEM_PROGRAM:
      // The wrap: a transfer from the wallet into its own wCOOK account. spendGuard pins how much.
      if (
        WRAPPING_KINDS.includes(kind) &&
        d.length === 12 &&
        d[0] === 2 &&
        d[1] === 0 &&
        d[2] === 0 &&
        d[3] === 0 &&
        acc(0) === own.wallet &&
        acc(1) === own.wcook
      ) {
        return;
      }
      throw no(`instruction ${at} is a system-program call a ${kind} has no use for`);
    case TOKEN_PROGRAM:
      // SyncNative (17) completes the wrap. An approve or transfer here would hand our tokens away.
      if (WRAPPING_KINDS.includes(kind) && d.length === 1 && d[0] === 17 && acc(0) === own.wcook)
        return;
      // CloseAccount (9) unwraps a claim's proceeds: our wCOOK account, to us, by us, last.
      if (
        UNWRAPPING_KINDS.includes(kind) &&
        closing &&
        d.length === 1 &&
        d[0] === 9 &&
        accounts.length === 3 &&
        acc(0) === own.wcook &&
        acc(1) === own.wallet &&
        acc(2) === own.wallet
      ) {
        return;
      }
      throw no(`instruction ${at} is a token-program call a ${kind} has no use for`);
    default:
      throw no(`instruction ${at} calls ${programId}, which no NFT build needs`);
  }
}

/** The program's error for a custom code, from the IDL. */
export function nftProgramError(code: number): { name: string; msg: string } | null {
  const e = (nftIdl as { errors: { code: number; name: string; msg?: string }[] }).errors.find(
    (x) => x.code === code,
  );
  return e ? { name: e.name, msg: e.msg ?? e.name } : null;
}
