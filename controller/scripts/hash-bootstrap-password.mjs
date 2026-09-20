import { hashPassword } from "better-auth/crypto";

// Read stdin rather than argv so a real deployment password need not appear
// in process listings. Output is the complete salt:hash consumed by Better Auth.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (!password) {
  process.stderr.write("Provide a non-empty password on stdin.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${await hashPassword(password)}\n`);
}
