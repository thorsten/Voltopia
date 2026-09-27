import { useEffect, useRef, useState } from 'react';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { DisasterKind, type DisasterStats } from '../shared/types.ts';
import { disasterLabelKey, useI18n } from './i18n.tsx';

const TOAST_MS = 5000;

const ICON: Record<DisasterKind, string> = {
  [DisasterKind.Storm]: '🌪',
  [DisasterKind.Fire]: '🔥',
  [DisasterKind.Flood]: '🌊',
};

/** In-game hours and minutes left, for the countdown. */
export function countdownParts(ticks: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.round((ticks / TICKS_PER_DAY) * 24 * 60));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Warnings with a countdown while a storm or flood is on its way, plus a
 * toast the moment something strikes. Fires have no warning, so they only
 * ever appear as an active event — which is the point of the mechanic.
 */
export function DisasterBanner({
  disasters,
  onWarning,
  onStrike,
}: {
  disasters: DisasterStats;
  /** Called once per new warning (plays the alarm). */
  onWarning?: (kind: DisasterKind) => void;
  /** Called once per newly active event. */
  onStrike?: (kind: DisasterKind) => void;
}) {
  const { t } = useI18n();
  const [toast, setToast] = useState<{ kind: DisasterKind } | null>(null);
  const knownWarnings = useRef<Set<number>>(new Set());
  const knownActive = useRef<Set<number>>(new Set());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    for (const event of disasters.pending) {
      if (knownWarnings.current.has(event.id)) continue;
      knownWarnings.current.add(event.id);
      onWarning?.(event.kind);
    }
    for (const event of disasters.active) {
      if (knownActive.current.has(event.id)) continue;
      knownActive.current.add(event.id);
      onStrike?.(event.kind);
      setToast({ kind: event.kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
    }
  }, [disasters, onWarning, onStrike]);

  const banners = [
    ...disasters.pending.map((event) => ({ event, warning: true })),
    ...disasters.active.map((event) => ({ event, warning: false })),
  ];

  return (
    <>
      {banners.length > 0 && (
        <div className="disaster-banners" data-testid="disaster-banners">
          {banners.map(({ event, warning }) => {
            const { hours, minutes } = countdownParts(event.ticks);
            return (
              <div
                key={event.id}
                className={`disaster-banner ${warning ? 'warning' : 'active'}`}
                data-testid={`disaster-${event.id}`}
              >
                <span aria-hidden="true">{ICON[event.kind]}</span>
                <strong>{t(disasterLabelKey(event.kind))}</strong>
                <span>
                  {warning
                    ? t('disaster.warning', { hours, minutes })
                    : t('disaster.active', { hours, minutes })}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {toast && (
        <div className="disaster-toast" data-testid="disaster-toast">
          {ICON[toast.kind]} {t('disaster.toast', { kind: t(disasterLabelKey(toast.kind)) })}
        </div>
      )}
    </>
  );
}
