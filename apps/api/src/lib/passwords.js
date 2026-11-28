import bcrypt from 'bcryptjs';

/**
 * Passwords ignore spaces at the start and end: temporary passwords copied from WhatsApp or an
 * email often bring a space along, and nobody can see it in the password field.
 */
export const cleanPassword = (pw) => String(pw ?? '').trim();

/**
 * Does `input` match the stored hash? Tries it without outer spaces first, then exactly as typed,
 * so a password saved before this rule that really starts or ends with a space still works.
 */
export async function passwordMatches(input, hash) {
  const raw = String(input ?? '');
  const trimmed = raw.trim();
  if (!hash) return false;
  if (await bcrypt.compare(trimmed, hash)) return true;
  return trimmed !== raw ? bcrypt.compare(raw, hash) : false;
}
