// Bootstrap + role dispatch. PROCESS_TYPE=worker runs the BullMQ worker;
// anything else (or unset) runs the API. One entrypoint means both Railway
// services share the same start command and config.
//
// In ESM, static imports run before any module code, so a crash during import
// (env validation, client construction) would otherwise kill the process
// before a single log line. The dynamic import puts a catch-all around the
// entire startup path.

/* eslint-disable no-console */
const role = process.env.PROCESS_TYPE === 'worker' ? 'worker' : 'server';
console.log(
  `[boot] starting unified-rag-mvp ${role} (node ${process.version}, PORT=${process.env.PORT ?? 'unset'})`,
);

process.on('uncaughtException', (err) => {
  console.error('[boot] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[boot] unhandledRejection:', err);
  process.exit(1);
});

try {
  await import(role === 'worker' ? './queues/worker.js' : './app.js');
} catch (err) {
  console.error('[boot] failed to start:', err);
  process.exit(1);
}
