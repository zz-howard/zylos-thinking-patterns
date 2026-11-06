// Child-process fixture clock: keep the current and unmodified release
// transcripts on the exact same time window without changing product source.
Date.now = () => Number(process.env.TEST_CLOCK_MS);
