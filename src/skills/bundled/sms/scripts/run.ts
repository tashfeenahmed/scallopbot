/**
 * Subprocess entry point for sms.
 *
 * The real work runs in-process (../phone_call/scripts/handler.ts, registered
 * by the gateway) because it needs the allowlist/approval store and the
 * budget tracker. A subprocess would bypass those, so it refuses.
 */
console.log(JSON.stringify({
  success: false,
  output: '',
  error: 'sms runs inside the ScallopBot gateway only (it needs approvals and the budget tracker).',
  exitCode: 1,
}));
process.exit(1);
