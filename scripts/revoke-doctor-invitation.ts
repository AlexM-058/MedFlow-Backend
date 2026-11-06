import 'dotenv/config';
import { z } from 'zod';
import { getAdminClient } from '../src/supabaseAdmin';

async function main(): Promise<void> {
  const args = z.tuple([z.uuid()]).safeParse(process.argv.slice(2));
  if (!args.success) throw new Error('Usage: revoke-doctor-invitation <invitation-id>');
  const { error } = await getAdminClient().rpc('medflow_revoke_doctor_invitation', { p_id: args.data[0] });
  if (error) throw new Error('Invitation revocation failed.');
  process.stdout.write('Invitation revoked.\n');
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Invitation revocation failed. Check server configuration.'}\n`);
  process.exitCode = 1;
});
