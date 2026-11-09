type ShutdownSteps = {
  closeHttp: () => Promise<void>;
  stopRunner: () => Promise<void>;
  stopMetrics: () => Promise<void>;
  stopAccounts: () => Promise<unknown>;
  stopPricing: () => Promise<void>;
  stopReports?: () => Promise<void>;
  endDatabase: () => Promise<void>;
  forceClose: () => void;
};

/** Admission closes immediately. The database remains available until all
 * accepted producers drain. The caller must exit on deadline failure: force
 * closing transports alone cannot cancel arbitrary JavaScript work.
 */
export async function drainController(steps: ShutdownSteps, deadlineMs = 25_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const drained = (async () => {
    const results = await Promise.allSettled([
      steps.closeHttp, steps.stopRunner, steps.stopMetrics, steps.stopAccounts,
    ].map(step => Promise.resolve().then(step)));
    // An accepted HTTP request may have started a pricing job after shutdown
    // began. Only inspect that service after HTTP and Runner producers stop.
    for (const step of [steps.stopReports ?? (async () => {}), steps.stopPricing, steps.endDatabase]) {
      try { await step(); } catch (reason) { results.push({ status: "rejected", reason }); }
    }
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  })();
  try {
    await Promise.race([drained, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Controller shutdown deadline exceeded")), deadlineMs);
    })]);
  } catch (error) {
    steps.forceClose();
    throw error;
  } finally { clearTimeout(timer); }
}
