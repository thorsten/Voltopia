import { BALANCE } from '../shared/constants.ts';
import { useI18n } from './i18n.tsx';

const { maxRate, step } = BALANCE.finance.gridFee;
/** Decimals the step needs, so 0.001 steps never print as 0.00. */
const DECIMALS = Math.max(0, Math.ceil(-Math.log10(step)));

/** Happiness term as a whole percentage, e.g. "−5 %" (0 stays unsigned). */
function happinessPercent(value: number): string {
  const percent = Math.round(Math.abs(value) * 100);
  return percent === 0 ? '0 %' : `${value < 0 ? '−' : '+'}${percent} %`;
}

/** Second money lever under the tax slider: a fee per EU billed to buildings. */
export function GridFeeSlider({
  rate,
  happiness,
  onChange,
}: {
  rate: number;
  /** Happiness term of the current fee (0 or negative). */
  happiness: number;
  onChange: (rate: number) => void;
}) {
  const { t } = useI18n();
  const steps = Math.round(rate / step);
  return (
    <label className="tax-slider" data-testid="grid-fee-slider">
      <span className="grid-fee-row">
        <span>
          {t('gridFee.label')} <strong>{rate.toFixed(DECIMALS)} ⌁/EU</strong>
        </span>
        <span className="smart-meters-coverage" data-testid="grid-fee-happiness">
          {t('gridFee.happiness', { value: happinessPercent(happiness) })}
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={Math.round(maxRate / step)}
        step={1}
        value={steps}
        onChange={(e) => onChange(Number((Number(e.target.value) * step).toFixed(DECIMALS)))}
      />
    </label>
  );
}
