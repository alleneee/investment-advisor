import type { ElementType, HTMLAttributes, ReactNode } from "react";

type PanelProps = {
  title: string;
  heading?: "h2" | "h3";
  children?: ReactNode;
  className?: string;
  as?: ElementType;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "children" | "className">;

export function Panel({ title, heading = "h2", children, className, as: Tag = "section", ...rest }: PanelProps) {
  const Heading = heading;
  return (
    <Tag className={["ui-panel", className].filter(Boolean).join(" ")} {...rest}>
      <Heading>{title}</Heading>
      {children}
    </Tag>
  );
}
