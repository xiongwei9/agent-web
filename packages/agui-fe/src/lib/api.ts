/** Endpoint the browser POSTs AG-UI runs to. Defaults to the Vite dev proxy. */
export const AGUI_URL = import.meta.env.VITE_AGUI_URL ?? "/agui";

/**
 * A side endpoint of the AG-UI server (e.g. `skills`), resolved against
 * {@link AGUI_URL} so a path prefix or remote origin carries over.
 */
export function apiUrl(path: string): string {
  return new URL(path, new URL(AGUI_URL, window.location.href)).href;
}
