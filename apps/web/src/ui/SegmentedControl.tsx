import type { HTMLAttributes, ReactNode } from "react";

type SegmentedControlProps = {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">;

export function SegmentedControl({ children, className, ...rest }: SegmentedControlProps) {
  return (
    <div className={["ui-segment", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
