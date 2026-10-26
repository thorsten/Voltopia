import { useEffect, useRef } from 'react';
import type { TownLayout } from '../shared/types.ts';
import { townTileColor } from './townColors.ts';

/** Paint a layout one pixel per tile in the minimap colours. */
export function paintTownPreview(context: CanvasRenderingContext2D, layout: TownLayout): void {
  const { size } = layout;
  for (let index = 0; index < size * size; index++) {
    context.fillStyle = townTileColor(layout, index);
    context.fillRect(index % size, Math.floor(index / size), 1, 1);
  }
}

/**
 * The import preview: a `size`×`size` canvas the stylesheet scales to
 * the dialog width, painted whenever the layout changes.
 */
export function TownPreview({ layout }: { layout: TownLayout }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (context) paintTownPreview(context, layout);
  }, [layout]);
  return (
    <canvas
      ref={canvasRef}
      className="town-preview"
      width={layout.size}
      height={layout.size}
      data-testid="import-town-preview"
    />
  );
}
