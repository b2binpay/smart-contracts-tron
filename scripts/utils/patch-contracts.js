const fs = require("node:fs");
const path = require("node:path");

const SOLC_TARGET = process.argv[2] || "0.8.24";
const SOURCE = path.join(__dirname, "..", "..", "contracts");
const DEST = path.join(__dirname, "..", "..", `${SOLC_TARGET}`, "contracts");

const ISTANBUL = path.join(__dirname, "..", "..", "istanbul", "contracts");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rewrite(content) {
  return content.replace(/^\s*pragma\s+solidity\s+[^;]+;/m, `pragma solidity ${SOLC_TARGET};`);
}

function copyTree(source, dest) {
  ensureDir(dest);
  for (const name of fs.readdirSync(source)) {
    const src = path.join(source, name);
    const dst = path.join(dest, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copyTree(src, dst);
    } else if (name.endsWith(".sol")) {
      fs.writeFileSync(dst, rewrite(fs.readFileSync(src, "utf8")));
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

ensureDir(DEST);
copyTree(SOURCE, DEST);
console.log(`Patched #pragma -> ${DEST}`);

if (fs.existsSync(ISTANBUL) && fs.statSync(ISTANBUL).isDirectory()) {
  copyTree(ISTANBUL, DEST);
  console.log(`Merged Istanbul -> ${DEST}`);
} else {
  console.log(`No {${ISTANBUL}} directory found — skipping merge step.`);
}
