import type { ElementType, ReactNode } from "react";

export function Panel({
  title,
  heading = "h2",
  children,
  className,
  as: Tag = "section",
}: {
  title: string;
  heading?: "h2" | "h3";
  children?: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  const Heading = heading;
  return (
    <Tag className={["ui-panel", className].filter(Boolean).join(" ")}>
      <Heading>{title}</Heading>
      {children}
    </Tag>
  );
}
