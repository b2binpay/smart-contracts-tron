const fs = require("node:fs");
const path = require("node:path");

const SOLC_TARGET = process.argv[2] || "0.8.25";
const CONTRACTS_DIR = path.resolve(__dirname, "..", "..", SOLC_TARGET, "contracts");
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "build", SOLC_TARGET, "flattened");

// Contracts to flatten (entry points for verification)
const ENTRY_CONTRACTS = [
  "MultiSigWallet.sol",
  "ProxyFactory.sol",
  "DepositAccount.sol",
  "FactoryA.sol",
  "FactoryB.sol",
];

/**
 * Recursively resolve imports and produce a single flattened Solidity file.
 * Handles duplicate imports by tracking already-included files.
 * Strips pragma/SPDX from imported files to avoid duplicates.
 */
function flatten(entryFile, contractsDir) {
  const included = new Set();
  const chunks = [];
  let pragmaLine = null;
  let spdxLine = null;

  function resolve(filePath) {
    const absolute = path.resolve(filePath);
    if (included.has(absolute)) return;
    included.add(absolute);

    if (!fs.existsSync(absolute)) {
      throw new Error(`File not found: ${absolute}`);
    }

    const content = fs.readFileSync(absolute, "utf8");
    const dir = path.dirname(absolute);
    const lines = content.split("\n");
    const bodyLines = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Capture first pragma and SPDX
      if (/^pragma\s+solidity\s+/.test(trimmed)) {
        if (!pragmaLine) pragmaLine = trimmed;
        continue;
      }
      if (/^\/\/\s*SPDX-License-Identifier:/.test(trimmed)) {
        if (!spdxLine) spdxLine = trimmed;
        continue;
      }
      // Skip SPDX-FileCopyrightText lines from dependencies
      if (/^\/\/\s*SPDX-FileCopyrightText:/.test(trimmed)) {
        continue;
      }

      // Resolve imports
      const importMatch = trimmed.match(/^import\s+.*["']([^"']+)["']\s*;/);
      if (importMatch) {
        const importPath = path.resolve(dir, importMatch[1]);
        resolve(importPath);
        continue;
      }

      bodyLines.push(line);
    }

    // Remove leading/trailing blank lines from chunk
    const body = bodyLines.join("\n").trim();
    if (body) {
      chunks.push(body);
    }
  }

  resolve(path.resolve(contractsDir, entryFile));

  const header = [spdxLine || "// SPDX-License-Identifier: MIT", pragmaLine || `pragma solidity ${SOLC_TARGET};`].join(
    "\n",
  );

  return `${header}\n\n${chunks.join("\n\n")}\n`;
}

// Main
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const available = ENTRY_CONTRACTS.filter((name) => fs.existsSync(path.join(CONTRACTS_DIR, name)));

if (available.length === 0) {
  console.error(`No entry contracts found in ${CONTRACTS_DIR}`);
  console.error("Run 'npm run patch-contracts' first.");
  process.exit(1);
}

for (const contract of available) {
  const flattened = flatten(contract, CONTRACTS_DIR);
  const outFile = path.join(OUTPUT_DIR, contract);
  fs.writeFileSync(outFile, flattened);
  console.log(`Flattened: ${contract} -> ${outFile}`);
}

console.log(`\nDone. ${available.length} contract(s) flattened to ${OUTPUT_DIR}`);
