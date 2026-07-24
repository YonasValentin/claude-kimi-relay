export interface HeartbeatOptions {
  readonly intervalMs: number;
  readonly onBeat: (elapsedMs: number) => void;
}

export interface Heartbeat {
  readonly recordActivity: () => void;
  readonly stop: () => void;
}

// Emits a beat only when a whole interval elapses with no recorded activity, so
// a caller polling task status can tell a silent-but-working run (a long agent
// sub-task) apart from a hung one — without spamming events while real progress
// is already flowing. The first interval is always suppressed: startup activity
// is imminent and a beat then would be noise.
export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  const startedAt = Date.now();
  let active = true;
  const timer = setInterval(() => {
    if (!active) options.onBeat(Date.now() - startedAt);
    active = false;
  }, options.intervalMs);
  timer.unref();
  return {
    recordActivity: () => {
      active = true;
    },
    stop: () => clearInterval(timer),
  };
}
