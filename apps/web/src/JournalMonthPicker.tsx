import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Icon } from "./ui/Icon";

interface JournalMonthPickerProps {
  value: string;
  label: string;
  onChange: (month: string) => void;
}

export function JournalMonthPicker({ value, label, onChange }: JournalMonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(value.slice(0, 4)));
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const selected = popoverRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const first = popoverRef.current?.querySelector<HTMLButtonElement>(".journal-month-grid button");
    (selected ?? first)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <div ref={containerRef} className="journal-month-select">
    <h2 aria-label={label}>
      <button
        ref={triggerRef}
        className="journal-month-trigger"
        type="button"
        aria-label="选择月份"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) setYear(Number(value.slice(0, 4)));
          setOpen(!open);
        }}
      >
        <span>{label}</span>
        <Icon icon={ChevronDown} size={18} />
      </button>
    </h2>
    {open && <div ref={popoverRef} className="journal-month-popover" role="dialog" aria-label="选择月份">
      <div className="journal-month-year">
        <button type="button" aria-label="上一年" onClick={() => setYear(year - 1)}><Icon icon={ChevronLeft} size={18} /></button>
        <strong>{year}年</strong>
        <button type="button" aria-label="下一年" onClick={() => setYear(year + 1)}><Icon icon={ChevronRight} size={18} /></button>
      </div>
      <div className="journal-month-grid">
        {Array.from({ length: 12 }, (_, index) => {
          const month = `${String(year).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}`;
          return <button key={index} type="button" aria-pressed={month === value} onClick={() => {
            setOpen(false);
            onChange(month);
            triggerRef.current?.focus();
          }}>{index + 1}月</button>;
        })}
      </div>
    </div>}
  </div>;
}
