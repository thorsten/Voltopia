import { useState } from 'react';
import { Modal } from './Modal.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';
import {
  DEFAULT_NEW_GAME,
  DIFFICULTIES,
  DISASTER_LEVELS,
  MAP_SIZES,
  seedFromText,
  storePendingNewGame,
} from './newGame.ts';

export function NewGamePage({
  onStart,
  onClose,
}: {
  /** Called after options are stored; should clear the autosave + reload. */
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [size, setSize] = useState<number>(DEFAULT_NEW_GAME.size);
  const [difficulty, setDifficulty] = useState<string>('normal');
  const [seedText, setSeedText] = useState('');
  const [disasters, setDisasters] = useState<number>(DEFAULT_NEW_GAME.disasterScale);

  const start = (): void => {
    const chosen = DIFFICULTIES.find((d) => d.id === difficulty) ?? DIFFICULTIES[1];
    storePendingNewGame({
      size,
      startingMoney: chosen.startingMoney,
      seed: seedFromText(seedText),
      disasterScale: disasters,
    });
    onStart();
  };

  return (
    <Modal title={t('newGame.title')} onClose={onClose} testId="new-game-page">
      <section>
        <h3>{t('newGame.mapSize')}</h3>
        <div className="option-row">
          {MAP_SIZES.map((option) => (
            <button
              key={option}
              type="button"
              className={size === option ? 'active' : ''}
              data-testid={`size-${option}`}
              onClick={() => setSize(option)}
            >
              {option}×{option}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t('newGame.difficulty')}</h3>
        <div className="option-row">
          {DIFFICULTIES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={difficulty === option.id ? 'active' : ''}
              data-testid={`difficulty-${option.id}`}
              title={`${option.startingMoney.toLocaleString('en-US')} ⌁`}
              onClick={() => setDifficulty(option.id)}
            >
              {t(`newGame.difficulty.${option.id}` as TranslationKey)}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t('newGame.disasters')}</h3>
        <div className="option-row">
          {DISASTER_LEVELS.map((level) => (
            <button
              key={level.id}
              type="button"
              className={disasters === level.scale ? 'active' : ''}
              data-testid={`disasters-${level.id}`}
              onClick={() => setDisasters(level.scale)}
            >
              {t(`newGame.disasters.${level.id}` as TranslationKey)}
            </button>
          ))}
        </div>
        <p className="option-hint">{t('newGame.disasters.hint')}</p>
      </section>
      <section>
        <h3>{t('newGame.seed')}</h3>
        <input
          type="text"
          className="seed-input"
          placeholder={t('newGame.seedPlaceholder')}
          value={seedText}
          data-testid="seed-input"
          onChange={(e) => setSeedText(e.target.value)}
        />
      </section>
      <div className="new-game-actions">
        <button type="button" className="primary" data-testid="start-city" onClick={start}>
          {t('newGame.start')}
        </button>
        <button type="button" onClick={onClose}>
          {t('newGame.cancel')}
        </button>
      </div>
      <p className="new-game-warning">{t('newGame.warning')}</p>
    </Modal>
  );
}
