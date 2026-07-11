import { completeDiscordPolicy, type AccessPolicy } from './policy.js';

/** Recording dependencies are required only when recording can be authorized. */
export async function assertConfiguredRecordingReady(
  recordPolicy: AccessPolicy,
  assertTranscriberReady: () => Promise<void>,
): Promise<void> {
  if (completeDiscordPolicy(recordPolicy)) {
    await assertTranscriberReady();
  }
}
