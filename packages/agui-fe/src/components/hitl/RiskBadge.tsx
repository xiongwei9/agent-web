import type { ApprovalRequest } from "../../lib/hitl";

const RISK_STYLES: Record<ApprovalRequest["risk"], string> = {
  low: "border-border text-muted",
  medium: "border-accent text-accent",
  high: "border-danger text-danger",
};

export function RiskBadge({
  risk,
  className = "",
}: {
  risk: ApprovalRequest["risk"];
  className?: string;
}) {
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-px text-[10px] leading-normal ${RISK_STYLES[risk]} ${className}`}
    >
      {risk} risk
    </span>
  );
}
