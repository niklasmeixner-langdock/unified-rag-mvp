// Bootstrap wrapper. In ESM, static imports run before any module code, so a
// crash during import (env validation, client construction) would otherwise
// kill the process before a single log line. The dynamic import here puts a
// catch-all around the entire startup path.

/* eslint-disable no-console */
console.log(`[boot] starting unified-rag-mvp API (node ${process.version}, PORT=${process.env.PORT ?? 'unset'})`);

process.on('uncaughtException', (err) => {
  console.error('[boot] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[boot] unhandledRejection:', err);
  process.exit(1);
});

try {
  await import('./app.js');
} catch (err) {
  console.error('[boot] failed to start:', err);
  process.exit(1);
}
