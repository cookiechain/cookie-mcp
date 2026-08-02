/**
 * CookOven `.cook` name service structural check — NOTHING IS SENT AND NOTHING IS SPENT:
 *   npx tsx scripts/verify-domains.ts
 *   OWNER=<pubkey> NAME=<label> npx tsx scripts/verify-domains.ts
 *
 * Runs with a freshly generated (unfunded) key, so every write path must stop at a guard before it
 * would sign: an unregistered name, a name owned by somebody else, a missing spend confirmation.
 * The reads hit the live registry, and the last section proves the registration price this client
 * computes equals the lamports the deployed program actually demands — it simulates a real
 * `register_domain` and reads the "insufficient lamports N, need M" line out of the program log.
 *
 * Registering for real costs thousands of COOK, so that is the only way to check the price without
 * spending: the simulation reverts inside the system program's transfer, after validation.
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const NAME = process.env.NAME?.trim() || "bot";
// A wallet known to own at least one name (the `bot.cook` holder).
const OWNER = process.env.OWNER?.trim() || "FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ";
const FREE_NAME = "cookie-mcp-verify-free";

async function expectFailure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, JSON.stringify(r)?.slice(0, 160));
  } catch (e) {
    const m = e instanceof Error ? e.message : JSON.stringify(e);
    const h = (e as { hint?: string } | null)?.hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const domains = await import("../src/core/domains");
  const program = await import("../src/core/domains/program");
  const { getConnection } = await import("../src/core/rpc");
  const conn = getConnection();

  console.log("Registry:");
  const cfg = await domains.fetchDomainsConfig(conn);
  console.log(
    `  ✓ config ${program.configPda().toBase58()} — COOK @ $${Number(cfg.cookUsdPriceMicro) / 1e6}, ` +
      `short $${Number(cfg.shortNameUsdCents) / 100}, long $${Number(cfg.longNameUsdCents) / 100}, ` +
      `fees → ${cfg.feeReceiver}`,
  );

  console.log("\nReads:");
  const taken = await domains.resolveDomain(NAME);
  console.log(
    `  ${taken.registered ? "✓" : "✗"} resolve_domain(${NAME}) → ` +
      `${taken.registered ? `owner ${taken.owner}, primary=${taken.isOwnersPrimary}, created ${taken.createdAt}` : "NOT registered"}`,
  );
  const free = await domains.resolveDomain(FREE_NAME);
  console.log(
    `  ${free.registered ? "✗" : "✓"} resolve_domain(${FREE_NAME}) → available, ` +
      `${free.price?.priceCook} COOK (${free.price?.tier} tier)`,
  );
  // The suffix is presentation only — both spellings must land on the same PDA.
  const suffixed = await domains.resolveDomain(`${NAME}.cook`);
  console.log(
    `  ${suffixed.account === taken.account ? "✓" : "✗"} the .cook suffix is optional (same account)`,
  );

  const owned = await domains.getOwnedDomains(OWNER);
  console.log(
    `  ✓ get_owned_domains(${OWNER.slice(0, 6)}…) → ${owned.count} name(s), primary ${owned.primary ?? "none"}`,
  );
  for (const d of owned.domains) {
    console.log(`      ${d.isPrimary ? "★" : " "} ${d.name.padEnd(20)} ${d.account}`);
  }

  console.log("\nName-aware address resolution:");
  const byName = await domains.resolveWallet(`${NAME}.cook`, "wallet");
  console.log(`  ✓ ${NAME}.cook → ${byName.pubkey.toBase58()}`);
  const byAddress = await domains.resolveWallet(OWNER, "wallet");
  console.log(
    `  ${byAddress.name === null ? "✓" : "✗"} a plain address passes through with no lookup`,
  );
  await expectFailure("an unregistered name does not resolve", () =>
    domains.resolveWallet(`${FREE_NAME}.cook`, "wallet"),
  );

  console.log("\nGuards (unfunded key — none of these reach a signature):");
  await expectFailure("register_domain without maxPriceCook quotes the price and stops", () =>
    domains.registerDomain({ name: FREE_NAME }),
  );
  await expectFailure("register_domain below the live price stops", () =>
    domains.registerDomain({ name: FREE_NAME, maxPriceCook: 1 }),
  );
  await expectFailure("register_domain on a taken name stops before any spend", () =>
    domains.registerDomain({ name: NAME, maxPriceCook: 1_000_000 }),
  );
  await expectFailure("an invalid name is rejected locally", () =>
    domains.resolveDomain("Not A Name!"),
  );
  await expectFailure("a name over 32 bytes never reaches findProgramAddress", () =>
    domains.resolveDomain("a".repeat(33)),
  );
  await expectFailure("set_primary_domain on a name this wallet does not own", () =>
    domains.setPrimaryDomain({ name: NAME }),
  );
  await expectFailure("set_primary_domain with neither name nor clear", () =>
    domains.setPrimaryDomain({}),
  );
  await expectFailure("clear_primary_domain with no primary set", () =>
    domains.setPrimaryDomain({ clear: true }),
  );
  await expectFailure("transfer_domain of a name this wallet does not own", () =>
    domains.transferDomain({ name: NAME, to: OWNER }),
  );
  await expectFailure("update_domain with nothing to update", () =>
    domains.updateDomain({ name: NAME }),
  );

  console.log("\nPrice, cross-checked against the deployed program (simulation only):");
  const payer = new PublicKey(OWNER);
  for (const label of ["zz9-verify".slice(0, 3), FREE_NAME]) {
    const expected = domains.priceView(cfg, label);
    const tx = new Transaction().add(
      program.registerDomainIx({
        label,
        payer,
        feeReceiver: new PublicKey(cfg.feeReceiver),
      }),
    );
    tx.feePayer = payer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    const logs = sim.value.logs ?? [];
    const need = /insufficient lamports \d+, need (\d+)/.exec(logs.join(" "))?.[1];
    const agrees = need === expected.priceRaw;
    console.log(
      `  ${need ? (agrees ? "✓" : "✗") : "·"} ${label.padEnd(24)} client ${expected.priceRaw} ` +
        `(${expected.priceCook} COOK, ${expected.tier}) vs program ${need ?? "n/a — payer can afford it"}`,
    );
    if (need && !agrees) {
      console.log(`      MISMATCH — registrationPriceRaw no longer matches the program`);
    }
    // The translation layer must turn the raw system-program failure into something readable.
    const translated = program.domainSimError(logs, label);
    if (translated) console.log(`      error translation: ${translated}`);
  }

  console.log("\nDone — no transaction was signed or sent.");
}

main().catch((e) => {
  console.error("verify-domains failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
