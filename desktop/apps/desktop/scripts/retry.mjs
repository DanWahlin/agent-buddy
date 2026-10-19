// Tries a task again after a network error that may pass, such as a timeout from a CI runner.
export class PermanentError extends Error {}

export async function retry(label, task, {attempts = 3, delayMs = 10_000} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || error instanceof PermanentError) throw error;
      console.log(`${label} failed (${error instanceof Error ? error.message : error}); `
        + `trying again (${attempt + 1} of ${attempts})`);
      await new Promise(resolve => setTimeout(resolve, attempt * delayMs));
    }
  }
}
