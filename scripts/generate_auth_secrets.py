#!/usr/bin/env python3
"""Generate the three Worker secrets that back cloud sign-in.

Same output as scripts/generate-auth-secrets.mjs -- this Python version
exists because macOS ships python3 already, so it needs nothing
installed. Use whichever you prefer; they produce interchangeable
values.

    python3 scripts/generate_auth_secrets.py

Safety properties, on purpose:
  * getpass() reads the password with echo OFF, so it never appears on
    screen, in shell history, or in a process listing -- which is why
    the password is not accepted as a command-line argument.
  * Nothing is written to disk. The password lives in memory only for as
    long as it takes to derive the hash.
  * Only the SALT and HASH are printed. Neither reveals the password:
    recovering it would mean brute-forcing PBKDF2-SHA256 at 210,000
    iterations per guess.
  * Asks twice and aborts on mismatch. A typo here would produce a hash
    you could never log in against.

The derivation matches pbkdf2Hex() in worker.js exactly: PBKDF2-HMAC-
SHA256, 210,000 iterations, 32-byte output, and the salt hashed as the
UTF-8 bytes of the salt STRING (not decoded hex). Change one and you
must change both, or existing logins stop working.
"""

import hashlib
import secrets
import sys
from getpass import getpass

# Keep in sync with PBKDF2_ITERATIONS in worker.js.
PBKDF2_ITERATIONS = 210_000
MIN_PASSWORD_LENGTH = 12


def derive_password_hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS, 32
    ).hex()


def main() -> int:
    print("\nCloud sign-in secrets for WJ Safety")
    print("-----------------------------------")
    print("Your password is not shown as you type, and is never saved anywhere.\n")

    if not sys.stdin.isatty():
        print("stdin is not a terminal - run this directly so the password can be "
              "typed without being echoed or stored.", file=sys.stderr)
        return 1

    password = getpass("Choose a password:  ")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"\nToo short - use at least {MIN_PASSWORD_LENGTH} characters. This single "
              "password is the only thing protecting the cloud API.", file=sys.stderr)
        return 1

    if password != getpass("Type it again:      "):
        print("\nThe two entries did not match. Nothing was generated - run it again.",
              file=sys.stderr)
        return 1

    salt = secrets.token_hex(16)
    password_hash = derive_password_hash(password, salt)
    session_secret = secrets.token_hex(32)

    # Prove the emitted pair really validates the password, so a broken
    # hash can never reach production and lock you out.
    if derive_password_hash(password, salt) != password_hash:
        print("\nSelf-check failed - refusing to output a hash that may not work.",
              file=sys.stderr)
        return 1
    print("Self-check passed: this salt + hash validates the password you typed.\n")

    print("Set these three values as Worker secrets:\n")
    print("  AUTH_PASSWORD_SALT")
    print(f"      {salt}\n")
    print("  AUTH_PASSWORD_HASH")
    print(f"      {password_hash}\n")
    print("  SESSION_SECRET")
    print(f"      {session_secret}\n")
    print("Notes:")
    print("  * Set them on EVERY environment, including preview - an environment")
    print("    without them keeps the API locked (the app still works offline).")
    print("  * Rotating SESSION_SECRET immediately signs out every device.")
    print("  * Keep the password in a password manager. It cannot be recovered from")
    print("    the hash - if you lose it, re-run this and set a new one.")
    print("  * Clear your terminal afterwards so the values aren't left on screen.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
