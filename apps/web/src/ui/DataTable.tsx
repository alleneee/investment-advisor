import type { TableHTMLAttributes } from "react";

export function DataTable(props: TableHTMLAttributes<HTMLTableElement>) {
  return <table {...props} className={["ui-table", props.className].filter(Boolean).join(" ")} />;
}
