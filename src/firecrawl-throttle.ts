const DEFAULT_MIN_INTERVAL_MS = 10000;

let nextRequestAt = 0;
let reservationTail = Promise.resolve();

// Signal and spot scrapes share one Firecrawl key and one Node process.
// Reserve request start times across both pipelines to stay below the key's
// request-per-minute limit even while their scans run concurrently.
export async function waitForFirecrawlSlot(): Promise<void> {
  const configured = Number(process.env.FIRECRAWL_MIN_INTERVAL_MS);
  const minIntervalMs = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MIN_INTERVAL_MS;

  const previousReservation = reservationTail;
  let releaseReservation = () => {};
  reservationTail = new Promise<void>((resolve) => {
    releaseReservation = resolve;
  });

  await previousReservation;
  try {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + minIntervalMs;
  } finally {
    releaseReservation();
  }
}
