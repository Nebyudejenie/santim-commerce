export function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase();
  return <span className={`status-pill status-pill--${key}`}>{status.replace(/_/g, " ")}</span>;
}
