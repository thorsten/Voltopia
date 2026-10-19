/**
 * Finance part of the budget section: credit rating, debt against the
 * lenders' cap, open credits (with early repayment for loans), today's
 * credit offers and the renewable grant pot.
 */
import type { CreditKind, FinanceStats } from '../shared/types.ts';
import { rejectionKey, useI18n, type TranslationKey } from './i18n.tsx';

function amount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Yearly rate as a percentage with at most one decimal, e.g. "8 %" or "6.5 %". */
function ratePercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10} %`;
}

export function FinancePanel({
  finance,
  onTakeCredit,
  onRepayCredit,
}: {
  finance: FinanceStats;
  onTakeCredit: (kind: CreditKind, amount: number) => void;
  onRepayCredit: (id: number) => void;
}) {
  const { t } = useI18n();
  const reasonText = (reason: string): string => {
    const key = rejectionKey(reason);
    return key ? t(key) : reason;
  };

  return (
    <div className="finance-panel" data-testid="finance-panel">
      <div className="budget-section-label finance-title">
        <span>{t('finance.title')}</span>
        <span
          className={`credit-rating rating-${finance.rating}`}
          data-testid="credit-rating"
          title={t(`rating.${finance.rating}` as TranslationKey)}
        >
          {t('finance.rating')} {finance.rating}
        </span>
      </div>

      <div className="finance-row" data-testid="finance-debt">
        <span>{t('finance.debt')}</span>
        <span className="finance-value">
          {amount(finance.debt)} / {amount(finance.debtCap)} ⌁{' '}
          <span className="finance-muted">{t('finance.cap')}</span>
        </span>
      </div>

      {finance.credits.length === 0 ? (
        <p className="finance-muted finance-empty">{t('finance.noCredits')}</p>
      ) : (
        <ul className="finance-credits">
          {finance.credits.map((credit) => (
            <li key={credit.id} data-testid={`credit-${credit.id}`}>
              <span className="finance-credit-text">
                <span>
                  {t(`credit.${credit.kind}`)} · {amount(credit.outstanding)} ⌁
                </span>
                <span className="finance-muted">
                  {t('credit.rate', { rate: ratePercent(credit.ratePerYear) })} ·{' '}
                  {t('credit.daysLeft', { days: credit.daysLeft })}
                </span>
              </span>
              {credit.repayable && (
                <button
                  type="button"
                  className="insulation-buy"
                  data-testid={`repay-credit-${credit.id}`}
                  onClick={() => onRepayCredit(credit.id)}
                >
                  {t('credit.repay')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {finance.offers.map((offer) => (
        <div key={offer.kind} className="finance-offer" data-testid={`credit-offer-${offer.kind}`}>
          <span className="finance-offer-label">
            {t(`credit.${offer.kind}`)}
            <span className="finance-muted">
              {offer.ratePerYear === null
                ? reasonText('creditRefused')
                : `${t('credit.rate', { rate: ratePercent(offer.ratePerYear) })} · ${t('credit.term', { days: offer.termDays })}`}
            </span>
          </span>
          <span className="finance-offer-buttons">
            {offer.amounts.map((value) => {
              const reason = offer.available[value] ?? null;
              return (
                <button
                  key={value}
                  type="button"
                  className="insulation-buy"
                  data-testid={`credit-${offer.kind}-${value}`}
                  disabled={reason !== null}
                  title={
                    reason === null
                      ? t('credit.take', { amount: amount(value) })
                      : reasonText(reason)
                  }
                  onClick={() => onTakeCredit(offer.kind, value)}
                >
                  +{amount(value)}
                </button>
              );
            })}
          </span>
        </div>
      ))}

      <div className="finance-row" data-testid="finance-grant">
        <span>{t('finance.grant')}</span>
        <span className="finance-value">
          {amount(finance.grantRemaining)} / {amount(finance.grantPot)} ⌁
        </span>
      </div>
    </div>
  );
}
