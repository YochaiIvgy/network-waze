"use client";

import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = { value: string; label: string; color?: string };

/** Shared keyboard-accessible menu; the popup escapes scrollable path columns. */
export function StyledSelect({ value, onChange, options, label, compact = false }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  compact?: boolean;
}) {
  const selected = options.find(option => option.value === value);
  return <Select.Root value={value} onValueChange={next => { if (next !== null) onChange(next); }} items={options} modal={false}>
    <Select.Trigger aria-label={label} className={`styled-select ${compact ? "select-compact" : ""}`}>
      {selected?.color && <span className="select-dot" style={{ background: selected.color }} />}
      <Select.Value>{selected?.label ?? "Choose…"}</Select.Value>
      <Select.Icon className="select-chevron"><ChevronDown size={12} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner className="select-positioner" align="start" sideOffset={5} alignItemWithTrigger={false}>
        <Select.Popup className="select-popup">
          <Select.List className="select-list">
            {options.map(option => <Select.Item key={option.value} value={option.value} label={option.label} className="select-option">
              {option.color && <span className="select-dot" style={{ background: option.color }} />}
              <Select.ItemText>{option.label}</Select.ItemText>
              <Select.ItemIndicator className="select-check"><Check size={13} /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>;
}
