/** Short unique id helper used for client-generated message and thread ids. */
export function uid(prefix = ""): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return prefix ? `${prefix}-${random}` : random;
}
