import { registerScenario } from '../registry.ts';
import { dunkelflaute } from './dunkelflaute.ts';
import { island } from './island.ts';
import { oldTown } from './oldTown.ts';
import { stormSeason } from './stormSeason.ts';

for (const def of [island, dunkelflaute, oldTown, stormSeason]) registerScenario(def);
