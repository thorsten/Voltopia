import type { Speed } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

const SPEEDS: Array<{ value: Speed; label: string; title: TranslationKey }> = [
  { value: 0, label: '⏸', title: 'speed.pause' },
  { value: 1, label: '▶', title: 'speed.normal' },
  { value: 3, label: '▶▶▶', title: 'speed.fast' },
  { value: 6, label: '▶▶▶▶', title: 'speed.veryFast' },
];

export function SpeedControls({
  speed,
  onChange,
}: {
  speed: Speed;
  onChange: (speed: Speed) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="speed-controls" data-testid="speed-controls">
      {SPEEDS.map(({ value, label, title }) => (
        <button
          key={value}
          type="button"
          title={t(title)}
          className={speed === value ? 'active' : ''}
          data-testid={`speed-${value}`}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
