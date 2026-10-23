import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "danger" | "secondary";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary: "border-transparent bg-accent-strong font-semibold text-white enabled:hover:bg-accent",
  danger: "border-danger bg-transparent font-semibold text-danger enabled:hover:bg-danger/10",
  secondary: "border-border bg-canvas text-ink enabled:hover:border-accent",
};

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.25",
  md: "px-4 py-2",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`cursor-pointer whitespace-nowrap rounded-lg border text-[13px] transition-colors disabled:cursor-default disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
}
