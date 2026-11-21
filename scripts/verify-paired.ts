// Live check of MomoSwap paired-launch support. Nothing is ever sent.
//
//   npx tsx scripts/verify-paired.ts            reads: pair assets, paired pools, a holder's view
//   npx tsx scripts/verify-paired.ts --launch   + a paired launch with a 1 COOK dev buy, run through
//                                                deploy_token in EXTERNAL-signer mode: login, build,
//                                                verify, simulate, then stop at needs_signature.
//                                                Needs COOKIE_PRIVATE_KEY (only to sign the login
//                                                message). Leases one `momo` mint from the launchpad.
//   npx tsx scripts/verify-paired.ts --trade    + `trade` of a graduated paired token (KITCHEN) both
//                                                ways on both aggregators, external-signer: proves the
//                                                spend guard accepts a taxed delivery, without sending.
import { loadKeypair } from "../src/core/wallet";

const KITCHEN = "AsonMnqP367GxcNun4dfpAPQrhJK4NBeGheC7GGvmomo";
const COOK = "So11111111111111111111111111111111111111112";
const HOLDER = "zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok";

// External-signer mode, with the key kept OUT of the process env so nothing can sign a transaction.
const secret = process.env.COOKIE_PRIVATE_KEY?.trim();
const keypair = secret ? loadKeypair(secret) : null;
delete process.env.COOKIE_PRIVATE_KEY;
process.env.COOKIE_SIGNER = "external";
if (keypair) process.env.COOKIE_WALLET_ADDRESS = keypair.publicKey.toBase58();

const show = (label: string, x: unknown) =>
  console.log(`\n== ${label}\n${JSON.stringify(x, null, 1).slice(0, 2500)}`);

async function main() {
  const lp = await import("../src/core/launchpad");
  const { SignatureRequired, LocalKeypairSigner } = await import("../src/core/signer");

  show("pair assets", await lp.getLaunchpadPairAssets());
  const pools = await lp.getLaunchpadPools({ status: "all", limit: 100 });
  show(
    "paired pools",
    pools.pools
      .filter((p) => p.paired)
      .map((p) => ({ symbol: p.symbol, status: p.status, ...p.paired })),
  );
  const pos = await lp.getLaunchpadPositions({ owner: HOLDER });
  show("holder view", { pairedHoldings: pos.pairedHoldings, next: pos.nextRewardPayoutAt });

  // A graduated paired pool must be refused on the curve before anything is built.
  if (keypair) {
    try {
      await lp.launchpadBuy({ ref: KITCHEN, amountCook: 1 });
      console.log("\n!! launchpad_buy on a graduated paired pool did NOT refuse");
    } catch (e) {
      console.log(`\n== launchpad_buy(graduated KITCHEN) refused: ${(e as Error).message}`);
    }
  }

  if (process.argv.includes("--trade") && keypair) {
    const { trade } = await import("../src/core/trade");
    for (const aggregator of ["cookiebox", "cookiescan"] as const) {
      for (const [inputMint, outputMint, amount] of [
        [COOK, KITCHEN, 10],
        [KITCHEN, COOK, 1000],
      ] as const) {
        const label = `trade ${aggregator} ${inputMint === COOK ? "buy" : "sell"} KITCHEN`;
        try {
          await trade({ inputMint, outputMint, amount, aggregator } as never);
          console.log(`\n!! ${label}: returned without needing a signature`);
        } catch (e) {
          if (e instanceof SignatureRequired) {
            console.log(`\n== ${label}: needs_signature (built, guarded, simulated)`);
          } else {
            console.log(`\n== ${label}: refused: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  if (process.argv.includes("--launch")) {
    if (!keypair) throw new Error("--launch needs COOKIE_PRIVATE_KEY to sign the login message");
    const args = {
      name: "Paired Probe",
      symbol: "PPROBE",
      noLogo: true,
      pairAsset: "bCOOK",
      holderTaxPct: 1,
      devBuyCook: 1,
      maxCostCook: 5,
    };
    let loginSignature: { message: string; signature: string } | undefined;
    for (let step = 0; step < 2; step++) {
      try {
        await lp.deployToken({ ...args, ...(loginSignature ? { loginSignature } : {}) });
        console.log("\n!! deploy_token returned without needing a signature");
        return;
      } catch (e) {
        if (!(e instanceof SignatureRequired)) throw e;
        const p = e.payload;
        if (p.kind === "message") {
          loginSignature = {
            message: p.message,
            signature: await new LocalKeypairSigner(keypair).signMessage(p.message),
          };
          console.log("\n== login message signed (session only — no transaction)");
          continue;
        }
        show("paired launch: needs_signature (built, verified, simulated — NOT sent)", {
          what: p.what,
          version: p.version,
          step: p.step,
          summary: p.summary,
        });
        return;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
