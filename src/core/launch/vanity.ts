// Vanity mint grinding. The DBC program doesn't pick the mint — we generate it locally and pass it as
// a signer — so we can grind the address to end with a suffix (Cookiebox launchpad convention: "box").
// @noble/curves keygen makes a 3-char suffix (~195K expected attempts) grind in a few seconds.
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_SET = new Set(BASE58_ALPHABET);

// Matches PublicKey.toBase58().
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

// `0`, `O`, `I`, `l` aren't in the base58 alphabet, so a suffix containing them can never appear.
export function isGrindableSuffix(suffix: string): boolean {
  if (suffix.length === 0) return false;
  for (const ch of suffix) if (!BASE58_SET.has(ch)) return false;
  return true;
}

// 64-byte ed25519 secret (seed ‖ publicKey) — the layout Keypair.fromSecretKey expects.
function secretKeyFromSeed(seed: Uint8Array): Uint8Array {
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);
  return secretKey;
}

export type GrindResult = { keypair: Keypair; address: string; attempts: number; vanity: boolean };

// Falls back to a plain random mint (vanity: false) if the suffix isn't grindable or the cap is hit —
// never block a launch on grinding.
export function grindVanityMint(suffix: string, maxAttempts = 1_500_000): GrindResult {
  if (!isGrindableSuffix(suffix)) {
    const kp = Keypair.generate();
    return { keypair: kp, address: kp.publicKey.toBase58(), attempts: 0, vanity: false };
  }
  const seed = new Uint8Array(32);
  for (let i = 1; i <= maxAttempts; i++) {
    crypto.getRandomValues(seed);
    const address = base58Encode(ed25519.getPublicKey(seed));
    if (address.endsWith(suffix)) {
      return {
        keypair: Keypair.fromSecretKey(secretKeyFromSeed(seed)),
        address,
        attempts: i,
        vanity: true,
      };
    }
  }
  const kp = Keypair.generate();
  return { keypair: kp, address: kp.publicKey.toBase58(), attempts: maxAttempts, vanity: false };
}
