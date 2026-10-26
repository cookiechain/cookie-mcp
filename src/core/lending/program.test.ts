import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  ACCOUNT_DISCRIMINATORS,
  IX_DISCRIMINATORS,
  LENDING_PROGRAM_ID,
  OBLIGATION_LEN,
  RESERVE_LEN,
  accrueIx,
  borrowIx,
  decodeGlobal,
  decodeMarket,
  decodeObligation,
  decodeOracle,
  decodeReserve,
  decodeRiskConfig,
  depositCollateralIx,
  globalPda,
  initObligationIx,
  lendingReservePda,
  lendingSimError,
  marketPda,
  obligationPda,
  obligationShareVaultPda,
  oraclePda,
  programDataAddress,
  refreshObligationIx,
  refreshOracleIx,
  repayIx,
  riskConfigPda,
  supplyIx,
  supplyPositionPda,
  withdrawCollateralIx,
  withdrawIx,
} from "./program";

// Live accounts read from Cookie Chain on 2026-10-26 (slot ~33.17M). Golden fixtures: they pin the
// byte layouts against silent drift the way domains/program.test.ts pins the `.cook` registry.
const FIXTURES = {
  global:
    "p+joschscn/rVB4xNe19Jn8woQFdUsFtwaSZN57RgnaQ8fX5WE8gUw9ZUdOz5KGUTNsDBfG7QgSDVJbrwD4a02MhNcw9bGrkAACAUQEAAAAAAP8C",
  market0:
    "277VNwDjxpqVopr8Nw2pjwohUVL8J0dG/zFmr/jpQIHz3JS9PKRAzAAAAAAAAAAABpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEJAAAAQWVyYSBDb3Jl/QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  cookReserve:
    "K/LMyhr3O38S1R9kyxXaVW1DAkwLFtMfiSxWpbkJfDXKSgraP3NwEgabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABut4QPy9FV93x0jHu9EdWTzuPsyXlsM+8Q9YWecWfixNE8c4hxG+MHMPlcMZk5GXXCCOMcnAv6QoaB4LU5qGKKEDbD0gGUf/VKTo5PKlxqvsXzFAvgv6y1znEreGSTo7YCTbfLSPsbQEAOK7FqoONAwCS2mjFWSACAAAAAAAAAAAAHlEPHl3g+g0AAAAAAAAAAIfhygEAAAAANiS0w2gBAAAAAAAAIAOIEwAAcBfIAOgDgD7cBQ8AAIDgN3nDEQAAgFPue6gKAAAg+E3ecAQAAQAASqIhBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4=",
  bcookReserve:
    "K/LMyhr3O38S1R9kyxXaVW1DAkwLFtMfiSxWpbkJfDXKSgraP3NwEsxFb83frASkAQKBPgDRfgjgRrrgfc4LJtiWl+JA35Kpa4ZL6lhbRoaZZp/GIIb9RhQJ0yfn7a1vgyag0SeMZFK8ai803/zrA9kSplErMRvh/48droevWoBakhQ5QLdQ7/8nYkIwlfG3iwVkO7Ar4jYuw4DkK483AN9jkGc3vQG7CSaoaz8p8w8AJqhrPynzDwAAAAAAAAAAAAAAAAAAAAAAAABkp7O24A0AAAAAAAAAAGeD0QEAAAAAAAAAAAAAAAB8FWQZIAOIE/QBcBfIAOgDKCPcBQ8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEASqIhBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP0=",
  cookOracle:
    "YZydvcJJCA8S1R9kyxXaVW1DAkwLFtMfiSxWpbkJfDXKSgraP3NwEgabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZKeztuANAAAAAAAAAAAAAGSns7bgDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMgAZADoAyAAAGSns7bgDQAAAAAAAAAAAABkp7O24A0AAAAAAAAAAAAAAAAAAAAAAAB9/PkBAAAAADbJ32oAAAAAAAAAAAAAAAAAffz5AQAAAAAAAAAAAAAAAP8=",
  bcookOracle:
    "YZydvcJJCA8S1R9kyxXaVW1DAkwLFtMfiSxWpbkJfDXKSgraP3NwEsxFb83frASkAQKBPgDRfgjgRrrgfc4LJtiWl+JA35KpAec+9q+8Jv4seqsCR46i9Ekg99Z4k28T5HjwfTU6j3rm7R0bnlQs8Zz9OolKWamgA3UynpgX/1eniYVTQcxXpQf0AQAAil14RWMBAAAAAAAAAAAAAOiJBCPHigAAAAAAAAAAzf9TAAAAAADlYD3a0tcmJbzqsGg6vwh8YdRXvupm/LR9QLrGTZRmg8gAZADoAyAcdq9ICwc4FAAAAAAAAAAAbTuNf8iB0BMAAAAAAAAAAMgATAAAAAAAAADCBfoBAAAAAEPN32oAAAAAAAAAAAAAAAAAwgX6AQAAAABMAAAAAAAAAP8=",
  riskConfig:
    "yXf19CgbAB/xRwWoJYOX7VHIpz+cXv0Zxp2QHPIqf8utA+QtxmvypgDyBSoBAAAAAAAA8gUqAQAAAJYAw1XRagAAAAD/",
  // A real borrower: one bCOOK collateral entry, one COOK borrow entry.
  obligation:
    "qM6NalhMrKcS1R9kyxXaVW1DAkwLFtMfiSxWpbkJfDXKSgraP3NwEsVGbe4TExFE/klurFs+CQq5z073is4TfQSm2t6dNeAx2OJ5AQAAAAABAHdx0q/1VQLk44UAAAAAAADK6wdnqdGbGDJ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAOL03SsdgCIn9UUAAAAAAADc8pEcrq7LXK1SAAAAAAAAAQAAANFHwty82bBtGJirkkKTYK5B7RUBjmKnFm9t9sQuQBuj8P6jSuu1AQB3cdKv9VUC5OOFAAAAAAAAAQAAAPXm93osDNMunvgxBJkcRGypmIoS2+LUTk4WMfid7exLwFQ5+BtLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const buf = (b64: string) => Buffer.from(b64, "base64");

const COOK = new PublicKey("So11111111111111111111111111111111111111112");
const BCOOK = new PublicKey("EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz");
const MARKET = new PublicKey("2GWpsJ5SVioi8TgWrhxDujro5f3YaR9Tyj1tHYr3Z8xZ");
const COOK_RESERVE = new PublicKey("HYu9wKdx2HYqqWJuxRyjdvPwGcAFbNgweUYFmMYYRhML");
const BCOOK_RESERVE = new PublicKey("F5wg8yURwVeWkMUqFHfTi2pUttP8sAQVYYE84MifjiSe");
const OWNER = new PublicKey("FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ");
const STAKE_POOL_PROGRAM = new PublicKey("GZgs5uREPp6BvDt8eysmhavQPAHBAtjePgV4zfhgd9pH");

const anchorDisc = (prefix: string, name: string) => [
  ...createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8),
];

describe("discriminators", () => {
  // Aera has no IDL; these are Anchor's defaults derived from the instruction / account names.
  it.each([
    ["accrue", "accrue"],
    ["refreshOracle", "refresh_oracle"],
    ["refreshObligation", "refresh_obligation"],
    ["initObligation", "init_obligation"],
    ["supply", "supply"],
    ["withdraw", "withdraw"],
    ["depositCollateral", "deposit_collateral"],
    ["withdrawCollateral", "withdraw_collateral"],
    ["borrow", "borrow"],
    ["repay", "repay"],
  ] as const)("instruction %s = sha256(global:%s)[..8]", (key, name) => {
    expect([...IX_DISCRIMINATORS[key]]).toEqual(anchorDisc("global", name));
  });

  it.each([
    ["global", "Global"],
    ["market", "Market"],
    ["reserve", "Reserve"],
    ["obligation", "Obligation"],
    ["oracleState", "OracleState"],
    ["supplyPosition", "SupplyPosition"],
    ["riskConfig", "RiskConfig"],
  ] as const)("account %s = sha256(account:%s)[..8]", (key, name) => {
    expect([...ACCOUNT_DISCRIMINATORS[key]]).toEqual(anchorDisc("account", name));
  });
});

describe("PDAs", () => {
  // Golden addresses — each verified to hold a live account on Cookie Chain (2026-10-26).
  it("derives the singleton global", () => {
    expect(globalPda().toBase58()).toBe("B57ZFSSKv4EThovKjumAwDL8dYogNKweKYXdr5Wc1sum");
  });
  it("derives markets from a u64 LE id", () => {
    expect(marketPda(0n).toBase58()).toBe(MARKET.toBase58());
    expect(marketPda(1n).toBase58()).toBe("5yJFpxhhzrmzq3AuiH2mhSxN1urRGnei6DNbyde5JqB8");
  });
  it("derives reserves and oracles from [market, mint]", () => {
    expect(lendingReservePda(MARKET, COOK).toBase58()).toBe(COOK_RESERVE.toBase58());
    expect(lendingReservePda(MARKET, BCOOK).toBase58()).toBe(BCOOK_RESERVE.toBase58());
    expect(oraclePda(MARKET, COOK).toBase58()).toBe("5NAq9f5athgdUD5BVdxu1L8UmRDUU25T9gsXrSXmArrs");
    expect(oraclePda(MARKET, BCOOK).toBase58()).toBe(
      "JB1o4dKGfwwGAfR9nDaqARR3wTgutZg2BiTBvfESdwDU",
    );
  });
  it("derives the obligation of the fixture borrower", () => {
    const ob = decodeObligation(buf(FIXTURES.obligation))!;
    expect(obligationPda(ob.market, ob.owner).toBase58()).toBe(
      "26sVsuVUMBzZwtkeznAJkJxcV9iS1pVhpYmT7coNQQwM",
    );
  });
  it("derives the risk config of the fixture reserve", () => {
    const rc = decodeRiskConfig(buf(FIXTURES.riskConfig))!;
    expect(riskConfigPda(rc.reserve).toBase58()).toBe(
      "DRwm2Ldoj3jSzE3u1DN3m7Hx75ud29daGZBnjrHCaQqc",
    );
  });
  it("derives the stake pool's ProgramData under the upgradeable loader", () => {
    expect(programDataAddress(STAKE_POOL_PROGRAM).toBase58()).toBe(
      "6Dsx1cdbzEsNaV4BKzJhEvTpuSGf4CcVH3UCt45mERTF",
    );
  });
  it("other PDAs are deterministic and program-owned", () => {
    for (const k of [
      supplyPositionPda(COOK_RESERVE, OWNER),
      obligationShareVaultPda(BCOOK_RESERVE, obligationPda(MARKET, OWNER)),
    ]) {
      expect(PublicKey.isOnCurve(k.toBytes())).toBe(false);
    }
  });
});

describe("account decoders", () => {
  it("decodes Global", () => {
    const g = decodeGlobal(buf(FIXTURES.global))!;
    expect(g.paused).toBe(false);
    expect(g.borrowPaused).toBe(false);
    expect(g.paramTimelockSeconds).toBe(86_400n);
    expect(g.version).toBe(2);
  });

  it("decodes Market", () => {
    const m = decodeMarket(buf(FIXTURES.market0))!;
    expect(m.marketId).toBe(0n);
    expect(m.name).toBe("Aera Core");
    expect(m.quoteCurrencyMint.toBase58()).toBe(COOK.toBase58());
  });

  it("decodes the COOK reserve (every offset pinned)", () => {
    const data = buf(FIXTURES.cookReserve);
    expect(data.length).toBe(RESERVE_LEN);
    const r = decodeReserve(data)!;
    expect(r.market.toBase58()).toBe(MARKET.toBase58());
    expect(r.liquidityMint.toBase58()).toBe(COOK.toBase58());
    expect(r.liquidityVault.toBase58()).toBe("DaTE6iWLdBTQbaXjodMHCBYKePdxpbu2SYndsL3EkbN2");
    expect(r.shareMint.toBase58()).toBe("5e8aUgeXhPHQcWSsNZmuTqSEEfJ6ihdNJ51mTM6dXSxX");
    expect(r.oracle.toBase58()).toBe("5NAq9f5athgdUD5BVdxu1L8UmRDUU25T9gsXrSXmArrs");
    expect(r.liquidityDecimals).toBe(9);
    expect(r.availableLiquidity).toBe(402_335_946_628_918n);
    expect(r.shareMintSupply).toBe(1_000_021_575_446_072n);
    expect(r.borrowedPrincipal).toBe(598_519_889_582_738n);
    expect(r.borrowIndex).toBe(1_007_364_157_211_627_806n);
    expect(r.lastUpdateSlot).toBe(30_073_223n);
    expect(r.config).toEqual({
      loanToValueBps: 0,
      liquidationThresholdBps: 0,
      liquidationBonusBps: 800,
      closeFactorBps: 5000,
      collateralHaircutBps: 0,
      optimalUtilizationBps: 6000,
      minBorrowRateBps: 200,
      optimalBorrowRateBps: 1000,
      maxBorrowRateBps: 16_000,
      reserveFactorBps: 1500,
      originationFeeBps: 15,
      supplyCap: 5_000_000_000_000_000n,
      borrowCap: 3_000_000_000_000_000n,
      perWalletSupplyCap: 1_250_000_000_000_000n,
      borrowEnabled: true,
      collateralEnabled: false,
      isolated: false,
      slotsPerYear: 69_313_098n,
    });
  });

  it("decodes the bCOOK reserve as collateral-only with an index of exactly 1", () => {
    const r = decodeReserve(buf(FIXTURES.bcookReserve))!;
    expect(r.liquidityMint.toBase58()).toBe(BCOOK.toBase58());
    expect(r.shareMint.toBase58()).toBe("DgVZKReoBCsF1qArEYsMCaR2La8sdNBacjBc7WQFYuZ8");
    expect(r.borrowIndex).toBe(10n ** 18n);
    expect(r.borrowedPrincipal).toBe(0n);
    expect(r.availableLiquidity).toBe(r.shareMintSupply);
    expect(r.config.borrowEnabled).toBe(false);
    expect(r.config.collateralEnabled).toBe(true);
    expect(r.config.loanToValueBps).toBe(5500);
    expect(r.config.liquidationThresholdBps).toBe(6500);
    expect(r.config.supplyCap).toBe(0n);
  });

  it("decodes both oracles", () => {
    const cook = decodeOracle(buf(FIXTURES.cookOracle))!;
    expect(cook.sourceKind).toBe("unitOfAccount");
    expect(cook.effectiveRate).toBe(10n ** 18n);
    expect(cook.health).toBe("healthy");
    expect(cook.sourceAccount.equals(SystemProgram.programId)).toBe(true);

    const bcook = decodeOracle(buf(FIXTURES.bcookOracle))!;
    expect(bcook.sourceKind).toBe("nativeExchangeRate");
    expect(bcook.sourceProgram.toBase58()).toBe(STAKE_POOL_PROGRAM.toBase58());
    expect(bcook.sourceAccount.toBase58()).toBe("GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4");
    expect(bcook.maxWithdrawalFeeBps).toBe(500);
    expect(bcook.grossRate).toBe(1_456_922_224_499_848_732n);
    expect(bcook.effectiveRate).toBe(1_427_783_780_009_851_757n);
    // effective = gross × (1 − 200 bps withdrawal fee)
    expect((bcook.grossRate * 9_800n) / 10_000n).toBe(bcook.effectiveRate);
    expect(bcook.withdrawalFeeBps).toBe(200);
    expect(bcook.health).toBe("healthy");
    expect(bcook.lastRefreshSlot).toBe(33_162_690n);
  });

  it("decodes an Obligation with one deposit and one borrow", () => {
    const data = buf(FIXTURES.obligation);
    expect(data.length).toBe(OBLIGATION_LEN);
    const ob = decodeObligation(data)!;
    expect(ob.market.toBase58()).toBe(MARKET.toBase58());
    expect(ob.owner.toBase58()).toBe("EH5c4qiAzQhMmWbabbB8QjgZ9VU6DoSfy2HJYRJwvsFv");
    expect(ob.stale).toBe(true); // borrow leaves it stale until the next refresh
    expect(ob.deposits).toHaveLength(1);
    expect(ob.deposits[0]!.reserve.toBase58()).toBe(BCOOK_RESERVE.toBase58());
    expect(ob.deposits[0]!.depositedShares).toBe(481_497_150_914_288n);
    expect(ob.borrows).toHaveLength(1);
    expect(ob.borrows[0]!.reserve.toBase58()).toBe(COOK_RESERVE.toBase58());
    expect(ob.borrows[0]!.borrowedPrincipal).toBe(82_583_500_707_008n);
    expect(ob.borrowedValue).toBe(0n); // cached from before the borrow — do not trust stored values
  });

  it("decodes RiskConfig", () => {
    const rc = decodeRiskConfig(buf(FIXTURES.riskConfig))!;
    expect(rc.perWalletBorrowCap).toBe(5_000_000_000n);
    expect(rc.protocolLiquidationShareBps).toBe(0);
  });

  it("rejects the wrong discriminator", () => {
    expect(decodeReserve(buf(FIXTURES.cookOracle))).toBeNull();
    expect(decodeOracle(buf(FIXTURES.cookReserve))).toBeNull();
    expect(decodeObligation(buf(FIXTURES.global))).toBeNull();
  });
});

describe("instruction encoding", () => {
  const cook = decodeReserve(buf(FIXTURES.cookReserve))!;
  const bcook = decodeReserve(buf(FIXTURES.bcookReserve))!;
  const bcookOracle = decodeOracle(buf(FIXTURES.bcookOracle))!;
  const cookOracle = decodeOracle(buf(FIXTURES.cookOracle))!;
  const obligation = obligationPda(MARKET, OWNER);
  const u64le = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };

  it("accrue is one writable reserve", () => {
    const ix = accrueIx(COOK_RESERVE);
    expect(ix.programId.equals(LENDING_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([...IX_DISCRIMINATORS.accrue]);
    expect(ix.keys).toEqual([{ pubkey: COOK_RESERVE, isSigner: false, isWritable: true }]);
  });

  it("refresh_oracle passes the stake pool + ProgramData only for a native-rate oracle", () => {
    const native = refreshOracleIx(bcook.oracle, bcookOracle);
    expect(native.keys.map((k) => k.pubkey.toBase58())).toEqual([
      bcook.oracle.toBase58(),
      "GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4",
      "6Dsx1cdbzEsNaV4BKzJhEvTpuSGf4CcVH3UCt45mERTF",
    ]);
    expect(native.keys.slice(1).every((k) => !k.isWritable && !k.isSigner)).toBe(true);
    const unit = refreshOracleIx(cook.oracle, cookOracle);
    expect(unit.keys).toHaveLength(1);
  });

  it("refresh_obligation lays [reserve, oracle] pairs after the obligation", () => {
    const ix = refreshObligationIx(obligation, [
      { reserve: BCOOK_RESERVE, oracle: bcook.oracle },
      { reserve: COOK_RESERVE, oracle: cook.oracle },
    ]);
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      obligation,
      BCOOK_RESERVE,
      bcook.oracle,
      COOK_RESERVE,
      cook.oracle,
    ]);
    expect(ix.keys[0]!.isWritable).toBe(true);
  });

  it("init_obligation", () => {
    const ix = initObligationIx({ market: MARKET, owner: OWNER });
    expect(ix.keys.map((k) => k.pubkey)).toEqual([
      MARKET,
      obligation,
      OWNER,
      SystemProgram.programId,
    ]);
    expect(ix.keys[2]).toMatchObject({ isSigner: true, isWritable: true });
  });

  it("supply / withdraw share the 12-account shape and differ only in discriminator", () => {
    const accounts = {
      reserve: COOK_RESERVE,
      reserveState: cook,
      userLiquidity: new PublicKey("11111111111111111111111111111112"),
      userShare: new PublicKey("11111111111111111111111111111113"),
      owner: OWNER,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
    };
    const s = supplyIx(accounts, 1_000_000_000n);
    const w = withdrawIx(accounts, 1_000_000_000n);
    expect(s.keys).toEqual(w.keys);
    expect(s.keys.map((k) => k.pubkey.toBase58())).toEqual([
      globalPda().toBase58(),
      COOK_RESERVE.toBase58(),
      COOK.toBase58(),
      cook.liquidityVault.toBase58(),
      cook.shareMint.toBase58(),
      accounts.userLiquidity.toBase58(),
      accounts.userShare.toBase58(),
      supplyPositionPda(COOK_RESERVE, OWNER).toBase58(),
      OWNER.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(s.keys.map((k) => k.isWritable)).toEqual([
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect([...s.data]).toEqual([...IX_DISCRIMINATORS.supply, ...u64le(1_000_000_000n)]);
    expect([...w.data]).toEqual([...IX_DISCRIMINATORS.withdraw, ...u64le(1_000_000_000n)]);
  });

  it("deposit_collateral / withdraw_collateral", () => {
    const userShare = new PublicKey("11111111111111111111111111111114");
    const a = { obligation, owner: OWNER, reserve: BCOOK_RESERVE, reserveState: bcook, userShare };
    const vault = obligationShareVaultPda(BCOOK_RESERVE, obligation);
    const d = depositCollateralIx(a, 5n);
    expect(d.keys.map((k) => k.pubkey)).toEqual([
      globalPda(),
      obligation,
      OWNER,
      BCOOK_RESERVE,
      bcook.shareMint,
      vault,
      userShare,
      TOKEN_2022_PROGRAM_ID,
      SystemProgram.programId,
    ]);
    expect([...d.data]).toEqual([...IX_DISCRIMINATORS.depositCollateral, ...u64le(5n)]);
    const w = withdrawCollateralIx(a, 5n);
    expect(w.keys.map((k) => k.pubkey)).toEqual([
      globalPda(),
      obligation,
      OWNER,
      BCOOK_RESERVE,
      bcook.oracle,
      bcook.shareMint,
      vault,
      userShare,
      TOKEN_2022_PROGRAM_ID,
    ]);
    expect(w.keys[2]).toMatchObject({ isSigner: true, isWritable: false });
  });

  it("borrow always names the risk-config PDA, repay lets anyone pay", () => {
    const userLiquidity = new PublicKey("11111111111111111111111111111115");
    const b = borrowIx(
      {
        obligation,
        owner: OWNER,
        reserve: COOK_RESERVE,
        reserveState: cook,
        userLiquidity,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
      },
      7n,
    );
    expect(b.keys.map((k) => k.pubkey)).toEqual([
      globalPda(),
      obligation,
      OWNER,
      COOK_RESERVE,
      cook.oracle,
      COOK,
      cook.liquidityVault,
      userLiquidity,
      TOKEN_PROGRAM_ID,
      riskConfigPda(COOK_RESERVE),
    ]);
    // No RiskConfig account exists at this address on-chain: the handler reads "absent" as
    // unlimited, but still demands the derived address be passed.
    expect(riskConfigPda(COOK_RESERVE).toBase58()).toBe(
      "HcasLoneTRVwjvf1UH24c7WBzXtZP5ZszZaD22XutrYv",
    );
    const r = repayIx(
      {
        obligation,
        reserve: COOK_RESERVE,
        reserveState: cook,
        userLiquidity,
        repayer: OWNER,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
      },
      9n,
    );
    expect(r.keys.map((k) => k.pubkey)).toEqual([
      obligation,
      COOK_RESERVE,
      COOK,
      cook.liquidityVault,
      userLiquidity,
      OWNER,
      TOKEN_PROGRAM_ID,
    ]);
    expect(r.keys[5]).toMatchObject({ isSigner: true, isWritable: false });
    expect([...r.data]).toEqual([...IX_DISCRIMINATORS.repay, ...u64le(9n)]);
  });
});

describe("lendingSimError", () => {
  it("translates Anchor error numbers from the AeraError enum", () => {
    expect(
      lendingSimError(["Program log: AnchorError ... Error Number: 6049. Error Message: x"]),
    ).toMatch(/loan-to-value/);
    expect(lendingSimError(["Error Number: 6012"])).toMatch(/not accrued/);
    expect(lendingSimError(["Error Number: 6028"])).toMatch(/EMERGENCY/);
  });
  it("falls through for unknown logs", () => {
    expect(lendingSimError(["Program failed: something else"])).toBeNull();
  });
});
