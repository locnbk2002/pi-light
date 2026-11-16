// Fixed subagent liveness limits (user decision: "max is 30 minutes. we should
// add heart beat"). Tests override them only through watcher deps.

/** Child heartbeat rewrite interval. */
export const HEARTBEAT_MS = 15_000;
/** Watcher poll interval. */
export const POLL_MS = 5_000;
/** No fresh heartbeat for this long → the child is considered dead. */
export const DEAD_AFTER_MS = 60_000;
/** No child activity for this long → one non-terminal stall warning. */
export const STALL_WARN_MS = 600_000;
/** Hard run limit for autonomous children (interactive children are exempt). */
export const MAX_RUN_MS = 1_800_000;
/** After a timeout interrupt, wait this long for a graceful `.exit` before killing. */
export const TIMEOUT_GRACE_MS = 10_000;
/** SIGTERM → SIGKILL escalation delay for headless process trees. */
export const KILL_ESCALATE_MS = 5_000;
