/**
 * Subprocess entry point for phone_call.
 *
 * The real work runs in-process (scripts/handler.ts, registered by the
 * gateway) because it needs the allowlist/approval store, the budget tracker
 * and the webhook server. A subprocess would bypass those, so it refuses.
 */
console.log(JSON.stringify({
  success: false,
  output: '',
  error: 'phone_call runs inside the ScallopBot gateway only (it needs approvals, the budget tracker and the webhook server).',
  exitCode: 1,
}));
process.exit(1);
