// Small building blocks shared by the «Код» dialogs (route.tsx and the G1.3 write flow in git-write-flow.tsx).
// The dialog frame itself (dismissal policy) stays in route.tsx.

export function DialogActions({
  disabled,
  onClose,
  saving,
  submitLabel,
}: {
  disabled?: boolean;
  onClose: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <div className="mt-2 flex justify-end gap-2 border-t border-subtle pt-4">
      <button
        type="button"
        className="rounded-md border border-subtle px-3 py-2 text-12 text-primary"
        onClick={onClose}
      >
        Отмена
      </button>
      <button
        type="submit"
        className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
        disabled={saving || disabled}
      >
        {saving ? "Сохраняем…" : submitLabel}
      </button>
    </div>
  );
}

export function FormInput({
  label,
  maxLength,
  onChange,
  placeholder,
  required,
  value,
}: {
  label: string;
  maxLength?: number;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  value: string;
}) {
  return (
    <label className="text-12 font-semibold text-secondary">
      {label}
      <input
        className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
        maxLength={maxLength}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function PreviewRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg border border-subtle bg-layer-1 p-3">
      <p className="text-11 font-semibold tracking-wide text-tertiary uppercase">{label}</p>
      <p className="mt-1 text-12 font-semibold break-words text-primary" title={title}>
        {value}
      </p>
    </div>
  );
}
