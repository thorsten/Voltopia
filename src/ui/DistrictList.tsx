import type { IslandStats } from '../shared/types.ts';
import { districtStatus, sortDistricts } from './districtStatus.ts';
import { useI18n } from './i18n.tsx';

function formatEnergy(value: number): string {
  return value.toFixed(1);
}

/**
 * One grid island's row in the district list: generation/consumption,
 * its storage SoC, its substation link count and a status derived the
 * same way the Grid overlay colours its tiles.
 */
function DistrictRow({
  island,
  selected,
  onSelect,
}: {
  island: IslandStats;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const status = districtStatus(island);
  return (
    <button
      type="button"
      className={`district-row ${status} ${selected ? 'selected' : ''}`}
      data-testid="district-row"
      onClick={onSelect}
      title={t('energy.districts.select')}
    >
      <span className="district-name">#{island.number}</span>
      <span>
        {t('energy.districts.figures', {
          generation: formatEnergy(island.generation),
          consumption: formatEnergy(island.consumption),
        })}
      </span>
      <span className="district-soc">
        <span className="soc-track">
          <span
            className="soc-fill"
            style={{
              width: `${island.capacity > 0 ? (100 * island.stored) / island.capacity : 0}%`,
            }}
          />
        </span>
      </span>
      <span className={`district-link ${island.substations === 0 ? 'none' : ''}`}>
        ⇄ {island.substations}
      </span>
      <span className="district-status">{t(`energy.districts.${status}`)}</span>
    </button>
  );
}

/**
 * Per-island breakdown below the city-wide rows: every grid island is
 * balanced on its own, so this is where a local blackout or curtailment
 * the city-wide sums hide shows up. Clicking a row selects (or
 * deselects) that island for the Grid overlay to highlight.
 */
export function DistrictList({
  islands,
  selectedIsland,
  onSelectIsland,
}: {
  islands: IslandStats[];
  selectedIsland: number;
  onSelectIsland: (n: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="district-list" data-testid="district-list">
      <h3>{t('energy.districts', { count: islands.length })}</h3>
      {islands.length === 0 && <p className="muted">{t('energy.districts.none')}</p>}
      {sortDistricts(islands).map((island) => (
        <DistrictRow
          key={island.number}
          island={island}
          selected={selectedIsland === island.number}
          onSelect={() => onSelectIsland(selectedIsland === island.number ? 0 : island.number)}
        />
      ))}
    </div>
  );
}
