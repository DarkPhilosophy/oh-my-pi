/**
 * Direct-load entry for the daemon session worker, used when no CLI host
 * entry exists (`bun test`, SDK embedding). The CLI host dispatches the
 * `__omp_worker_daemon_session` selector instead.
 */
import { runDaemonSessionWorker } from "./session-worker";

await runDaemonSessionWorker();
