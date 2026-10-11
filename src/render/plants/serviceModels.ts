import type { PlantType } from '../../shared/types.ts';
import type { PlantModel } from './models.ts';

/** Service, grid and rail building models. */
export const serviceModels: Partial<Record<PlantType, () => PlantModel>> = {};
