import 'dotenv/config';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { getAdminClient } from '../src/supabaseAdmin';
import { accountLink } from '../src/account/links';

async function main(): Promise<void> {
  const args = z.tuple([z.email().max(320), z.string().trim().min(1).max(200),
    z.string().trim().min(1).max(200), z.string().trim().min(1).max(200)])
    .safeParse(process.argv.slice(2));
  if (!args.success) throw new Error('Usage: create-doctor-invitation <email> <full-name> <specialty> <clinic>');
  const [email, fullName, specialty, clinic] = args.data;
  const token = randomBytes(32).toString('base64url');
  const link = accountLink(`doctor/invite/${token}`);
  const { data, error } = await getAdminClient().rpc('medflow_create_doctor_invitation', {
    p_email: email.trim().toLowerCase(), p_full_name: fullName, p_specialty: specialty,
    p_clinic: clinic, p_token_hash: createHash('sha256').update(token).digest('hex'),
  });
  if (error || !z.object({ id: z.uuid(), expiresAt: z.string() }).safeParse(data).success) {
    throw new Error('Invitation creation failed. Check server configuration and migration availability.');
  }
  // This explicit operator command is the only place the raw invitation is output.
  process.stdout.write(`${link}\n`);
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Invitation creation failed. Check server configuration.'}\n`);
  process.exitCode = 1;
});
