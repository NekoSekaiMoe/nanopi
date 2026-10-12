import { useState, useEffect, useRef } from 'preact/hooks';
import { ApprovalMode, getExtraState } from '../api';
import { useT } from '../settings';
import { MsgKey } from '../i18n';

// Run modes shown in the pill dropdown (desktop) / bottom sheet (mobile).
// Order = display order. Plan stays safety-green; standard is the default.
const MODE_OPTIONS: { val: ApprovalMode; label: MsgKey; desc: MsgKey }[] = [
  { val: 'standard', label: 'mode.standard', desc: 'mode.standard.desc' },
  { val: 'plan', label: 'mode.plan', desc: 'mode.plan.desc' },
  { val: 'minimal', label: 'mode.minimal', desc: 'mode.minimal.desc' },
];

/** Touch-friendly viewport: switch the dropdown to a bottom sheet. */
function useIsTouchViewport(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 640px)').matches : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(max-width: 640px)');
    const listener = (e: MediaQueryListEvent) => setNarrow(e.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return narrow;
}

export function ModeSelector({
  value,
  disabled = false,
  onChange,
}: {
  value: ApprovalMode;
  disabled?: boolean;
  onChange: (m: ApprovalMode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const isTouch = useIsTouchViewport();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Degradation: builds without the extra module 404 the probe — hide the
    // selector entirely instead of showing options that would snap back.
    let cancelled = false;
    getExtraState().then((state) => {
      if (!cancelled && !state) setHidden(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (hidden) return null;
  const current = MODE_OPTIONS.find((o) => o.val === value) ?? MODE_OPTIONS[0];
  const isPlan = value === 'plan';
  const pick = (val: ApprovalMode) => {
    if (disabled) return;
    onChange(val);
    setOpen(false);
  };
  const optionButtons = MODE_OPTIONS.map((o) => (
    <button
      key={o.val}
      class={'model-item mode-item' + (o.val === value ? ' active' : '')}
      type="button"
      disabled={disabled}
      onClick={() => pick(o.val)}
    >
      <span class="model-item-model">{t(o.label)}</span>
      <span class="mode-item-desc">{t(o.desc)}</span>
    </button>
  ));
  if (isTouch && open) {
    // Bottom sheet: large hit areas, dimmed backdrop, tap-outside closes.
    return (
      <>
        <div class="mode-selector">
          <button
            class={'model-selector-trigger mode-selector-trigger' + (isPlan ? ' mode-bypass' : '')}
            onClick={() => setOpen((o) => !o)}
            disabled={disabled}
            type="button"
            title={t('mode.label')}
          >
            <span class="effort-prefix">{t('mode.label')}</span>
            <span class="model-selector-label">{t(current.label)}</span>
            <span class="model-selector-chevron">▾</span>
          </button>
        </div>
        <div class="mode-sheet-backdrop" onClick={() => setOpen(false)}>
          <div class="mode-sheet" onClick={(e) => e.stopPropagation()} ref={ref}>
            <div class="mode-sheet-handle" />
            {optionButtons}
          </div>
        </div>
      </>
    );
  }
  return (
    <div class="model-selector model-selector-up mode-selector" ref={ref}>
      <button
        class={'model-selector-trigger mode-selector-trigger' + (isPlan ? ' mode-bypass' : '')}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        disabled={disabled}
        type="button"
        title={t('mode.label')}
      >
        <span class="effort-prefix">{t('mode.label')}</span>
        <span class="model-selector-label">{t(current.label)}</span>
        <span class="model-selector-chevron">▾</span>
      </button>
      {open && <div class="model-dropdown mode-dropdown">{optionButtons}</div>}
    </div>
  );
}
