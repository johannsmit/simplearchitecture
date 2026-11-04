/** Leaving the app for an AI agent's address (one object, so tests can watch it). */
export const browser = {
  leave(url: string): void {
    window.location.assign(url);
  },
};
