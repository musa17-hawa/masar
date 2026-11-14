// Add a teammate from the command line (stop the server first, it keeps accounts in memory):
//   npm run add-user -- name@example.com "a strong password" "Display Name" [admin]
import { createUser } from '../server/auth.js';
import { db } from '../server/db.js';

const [email, password, name, role] = process.argv.slice(2);
if (!email || !password) {
  console.log('Usage: npm run add-user -- <email> <password> [name] [admin]');
  process.exit(1);
}
try {
  const user = createUser({ email, password, name, role: role === 'admin' || db.users.length === 0 ? 'admin' : 'member' });
  db.saveNow();
  console.log(`Added ${user.email} (${user.role}).`);
} catch (err) {
  const reasons = { email_invalid: 'That email address is not valid.', email_taken: 'An account with that email already exists.', password_short: 'The password needs at least 8 characters.' };
  console.error(reasons[err.message] || err.message);
  process.exit(1);
}
