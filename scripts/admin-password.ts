// Make the admin page's password hash: npm run -s admin-password
//
// Type the password (or pipe it in). It prints a line like ADMIN_PASSWORD_HASH=scrypt$…, which
// is a one-way hash: it can check the password but can't be turned back into it. Put that line in
// .env.local for local testing (git ignores the file), or store the hash in AWS Parameter Store
// for the real site (see deploy/README.md). Never commit the password or the hash.
import { createInterface } from 'node:readline';
import { hashAdminPassword } from '../packages/server/src/adminAuth';

const valueOnly = process.argv.includes('--value');
let input = '';
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  input = await new Promise<string>((resolve) => rl.question('Admin password: ', (a) => (rl.close(), resolve(a))));
} else {
  for await (const chunk of process.stdin) input += chunk;
}
const password = input.replace(/\r?\n$/, '');
if (password.length < 10) {
  console.error('Use at least 10 characters.');
  process.exit(1);
}
const hash = hashAdminPassword(password);
console.log(valueOnly ? hash : `ADMIN_PASSWORD_HASH=${hash}`);
