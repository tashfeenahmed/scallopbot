/**
 * Subprocess entry point for image_gen.
 *
 * The real work runs in-process (scripts/handler.ts, registered by the
 * gateway) because it needs the live cost tracker and the user's channel.
 * A subprocess cannot enforce the budget, so it refuses instead of spending.
 */
console.log(JSON.stringify({
  success: false,
  output: '',
  error: 'image_gen runs inside the ScallopBot gateway only (it needs the budget tracker and the chat channel).',
  exitCode: 1,
}));
process.exit(1);
