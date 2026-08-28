/**
 * Convert a number to hex32 bytes (0x0000...0000)
 * @param {number|bigint} value - Value to convert
 * @returns {string} Hex string with 32 bytes
 */
function toHex32(value) {
  const bn = typeof value === "bigint" ? value : BigInt(value);
  return `0x${bn.toString(16).padStart(64, "0")}`;
}

// ERC20 Token Configuration
const ERC20_NAME = "ERC20Mock";
const ERC20_SYMBOL = "E20M";
const ERC20_INITIAL_SUPPLY = 1000000000000000000000n; // 1000 tokens with 18 decimals

// Deposit accounts configuration for testing
const DEPOSITS = [
  { id: toHex32(0n), amount: 10n },
  { id: toHex32(1n), amount: 1n },
  { id: toHex32(3n), amount: 3n },
  { id: toHex32(13n), amount: 13n },
  { id: toHex32(987n), amount: 987n },
  { id: toHex32(9999n), amount: 9999n },
  { id: toHex32(1000000n), amount: 1000000n },
  { id: toHex32(8888888888n), amount: 8888888888n },
  { id: toHex32(9007199254740990n), amount: 9007199254740990n }, // Number.MAX_SAFE_INTEGER - 1
];

// TRON specific constants
const TRON_ENERGY_LIMIT = 100000000; // 100M energy limit
const TRON_FEE_LIMIT = 1000000000; // 1000 TRX fee limit in TRX

module.exports = {
  ERC20_NAME,
  ERC20_SYMBOL,
  ERC20_INITIAL_SUPPLY,
  DEPOSITS,
  TRON_ENERGY_LIMIT,
  TRON_FEE_LIMIT,
  toHex32,
};
