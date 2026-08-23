#!/usr/bin/env node
// ---------------------------------------------------------------------
// generate-auth-secrets.mjs
//
// Generates the three Worker secrets that back cloud sign-in:
//   AUTH_PASSWORD_SALT, AUTH_PASSWORD_HASH, SESSION_SECRET
//
// Run it locally:
//   node scripts/generate-auth-secrets.mjs
//
// Safety properties, on purpose:
//   * The password is read from the terminal with echo OFF, so it never
//     appears on screen, in your shell history, or in a process listing
//     (which is exactly why it is NOT a command-line argument).
//   * Nothing is written to disk. The password exists only in memory for
//     the moment it takes to derive the hash.
//   * Only the SALT and the HASH are printed. Neither reveals the
//     password: recovering it would require brute-forcing PBKDF2-SHA256
//     at 210,000 iterations per guess.
//   * It asks twice and refuses to continue on a mismatch. A typo here
//     would produce a hash you could never log in against.
//
// The derivation below is deliberately identical to pbkdf2Hex() in
// worker.js -- same WebCrypto call, same iteration count, same treatment
// of the salt (the UTF-8 bytes of the salt STRING, not decoded hex). If
// you ever change one, change both, or existing logins stop working.
// ---------------------------------------------------------------------

import { webcrypto, randomBytes } from "node:crypto";

// Keep in sync with PBKDF2_ITERATIONS in worker.js.
const PBKDF2_ITERATIONS = 210000;
const MIN_PASSWORD_LENGTH = 12;

export async function derivePasswordHash(password, saltString) {
  const enc = new TextEncoder();
  const keyMaterial = await webcrypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(saltString), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Reads a line from the TTY without echoing it. Refuses to run when
// stdin is not a terminal (piped/redirected), because in that case the
// password would likely be sitting in a file or a shell history entry --
// better to fail loudly than to quietly accept an exposed secret.
function readSecretLine(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("stdin is not a terminal — run this directly so the password can be typed without being echoed or stored."));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") { // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") { // backspace
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  console.log("\nCloud sign-in secrets for WJ Safety");
  console.log("───────────────────────────────────");
  console.log("Your password is not shown as you type, and is never saved anywhere.\n");

  const password = await readSecretLine("Choose a password:  ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`\nToo short — use at least ${MIN_PASSWORD_LENGTH} characters. This single password is the only thing protecting the cloud API.`);
    process.exit(1);
  }

  const confirm = await readSecretLine("Type it again:      ");
  if (password !== confirm) {
    console.error("\nThe two entries did not match. Nothing was generated — run it again.");
    process.exit(1);
  }

  const salt = randomBytes(16).toString("hex");
  const hash = await derivePasswordHash(password, salt);
  const sessionSecret = randomBytes(32).toString("hex");

  // Prove the stored pair actually validates the password, so a broken
  // hash can never reach production and lock you out.
  if ((await derivePasswordHash(password, salt)) !== hash) {
    console.error("\nSelf-check failed — refusing to output a hash that may not work.");
    process.exit(1);
  }
  console.log("Self-check passed: this salt + hash validates the password you typed.\n");

  console.log("Run these three commands. Paste each value when prompted:\n");
  console.log("  npx wrangler secret put AUTH_PASSWORD_SALT");
  console.log(`      ${salt}\n`);
  console.log("  npx wrangler secret put AUTH_PASSWORD_HASH");
  console.log(`      ${hash}\n`);
  console.log("  npx wrangler secret put SESSION_SECRET");
  console.log(`      ${sessionSecret}\n`);
  console.log("Notes:");
  console.log("  • Set these on EVERY environment, including preview — an environment");
  console.log("    without them keeps the API locked (the app still works offline).");
  console.log("  • Rotating SESSION_SECRET immediately signs out every device.");
  console.log("  • Keep the password in a password manager. It cannot be recovered");
  console.log("    from the hash — if you lose it, re-run this and set a new one.");
  console.log("  • Clear your terminal afterwards so the values aren't left on screen.\n");
}

// Only run the prompt flow when executed directly, so the derivation
// function above can be imported and tested without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("\n" + err.message);
    process.exit(1);
  });
}
