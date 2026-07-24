import type { Bounds, InkPoint, InkStroke } from "./types";

export interface PreprocessingConfig {
  version: string;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  paddingRatio: number;
  minimumPadding: number;
  minimumExtent: number;
  minimumPathLength: number;
  strokeWidth: number;
  samplesPerAxis: number;
  coordinateGrid: number;
}

export const PREPROCESSING_CONFIG: Readonly<PreprocessingConfig> =
  Object.freeze({
    version: "digits-model-input-v1",
    width: 128,
    height: 32,
    contentWidth: 120,
    contentHeight: 26,
    paddingRatio: 0.1,
    minimumPadding: 1,
    minimumExtent: 4,
    minimumPathLength: 8,
    strokeWidth: 2.5,
    samplesPerAxis: 4,
    coordinateGrid: 64,
  });

export interface RasterGeometry {
  sourceBounds: Bounds;
  paddedBounds: Bounds;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RasterizedInk {
  data: Float32Array;
  shape: readonly [1, 1, number, number];
  width: number;
  height: number;
  geometry: RasterGeometry;
  preprocessingVersion: string;
}

function isFinitePoint(point: InkPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function makeBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Bounds {
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function computeBounds(strokes: readonly InkStroke[]): Bounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (!isFinitePoint(point)) {
        continue;
      }
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX)) {
    return null;
  }

  return makeBounds(minX, minY, maxX, maxY);
}

export function totalPathLength(strokes: readonly InkStroke[]): number {
  let total = 0;

  for (const stroke of strokes) {
    let previous: InkPoint | undefined;
    for (const point of stroke.points) {
      if (!isFinitePoint(point)) {
        continue;
      }
      if (previous) {
        total += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
      previous = point;
    }
  }

  return total;
}

export function prepareRasterGeometry(
  strokes: readonly InkStroke[],
  config: Readonly<PreprocessingConfig> = PREPROCESSING_CONFIG,
): RasterGeometry | null {
  const sourceBounds = computeBounds(strokes);
  if (!sourceBounds) {
    return null;
  }

  const extent = Math.max(sourceBounds.width, sourceBounds.height);
  if (
    extent < config.minimumExtent ||
    totalPathLength(strokes) < config.minimumPathLength
  ) {
    return null;
  }

  const padding = Math.max(config.minimumPadding, extent * config.paddingRatio);
  const paddedBounds = makeBounds(
    sourceBounds.minX - padding,
    sourceBounds.minY - padding,
    sourceBounds.maxX + padding,
    sourceBounds.maxY + padding,
  );
  const scale = Math.min(
    config.contentWidth / paddedBounds.width,
    config.contentHeight / paddedBounds.height,
  );
  const fittedWidth = paddedBounds.width * scale;
  const fittedHeight = paddedBounds.height * scale;

  return {
    sourceBounds,
    paddedBounds,
    scale,
    offsetX: (config.width - fittedWidth) / 2 - paddedBounds.minX * scale,
    offsetY: (config.height - fittedHeight) / 2 - paddedBounds.minY * scale,
  };
}

export function transformPoint(
  point: Pick<InkPoint, "x" | "y">,
  geometry: RasterGeometry,
  coordinateGrid = PREPROCESSING_CONFIG.coordinateGrid,
): Pick<InkPoint, "x" | "y"> {
  const round = (value: number) =>
    Math.round(value * coordinateGrid) / coordinateGrid;
  return {
    x: round(point.x * geometry.scale + geometry.offsetX),
    y: round(point.y * geometry.scale + geometry.offsetY),
  };
}

function squaredDistanceToSegment(
  x: number,
  y: number,
  start: Pick<InkPoint, "x" | "y">,
  end: Pick<InkPoint, "x" | "y">,
): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared === 0) {
    return (x - start.x) ** 2 + (y - start.y) ** 2;
  }

  const projection = Math.min(
    1,
    Math.max(
      0,
      ((x - start.x) * segmentX + (y - start.y) * segmentY) / lengthSquared,
    ),
  );
  const nearestX = start.x + projection * segmentX;
  const nearestY = start.y + projection * segmentY;
  return (x - nearestX) ** 2 + (y - nearestY) ** 2;
}

function paintCapsule(
  sampleMasks: Uint32Array,
  start: Pick<InkPoint, "x" | "y">,
  end: Pick<InkPoint, "x" | "y">,
  config: Readonly<PreprocessingConfig>,
): void {
  const radius = config.strokeWidth / 2;
  const radiusSquared = radius * radius;
  const minimumX = Math.max(0, Math.floor(Math.min(start.x, end.x) - radius));
  const maximumX = Math.min(
    config.width - 1,
    Math.ceil(Math.max(start.x, end.x) + radius),
  );
  const minimumY = Math.max(0, Math.floor(Math.min(start.y, end.y) - radius));
  const maximumY = Math.min(
    config.height - 1,
    Math.ceil(Math.max(start.y, end.y) + radius),
  );

  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const index = y * config.width + x;
      for (let sampleY = 0; sampleY < config.samplesPerAxis; sampleY += 1) {
        for (let sampleX = 0; sampleX < config.samplesPerAxis; sampleX += 1) {
          const bit = sampleY * config.samplesPerAxis + sampleX;
          const sampleCoordinateX = x + (sampleX + 0.5) / config.samplesPerAxis;
          const sampleCoordinateY = y + (sampleY + 0.5) / config.samplesPerAxis;
          if (
            squaredDistanceToSegment(
              sampleCoordinateX,
              sampleCoordinateY,
              start,
              end,
            ) <= radiusSquared
          ) {
            sampleMasks[index] = (sampleMasks[index] ?? 0) | (1 << bit);
          }
        }
      }
    }
  }
}

function countSetBits(value: number): number {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining > 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

export function rasterizeInk(
  strokes: readonly InkStroke[],
  config: Readonly<PreprocessingConfig> = PREPROCESSING_CONFIG,
): RasterizedInk | null {
  if (config.samplesPerAxis ** 2 > 32) {
    throw new RangeError("samplesPerAxis must fit in a 32-bit coverage mask");
  }

  const geometry = prepareRasterGeometry(strokes, config);
  if (!geometry) {
    return null;
  }

  const sampleMasks = new Uint32Array(config.width * config.height);
  for (const stroke of strokes) {
    const points = stroke.points
      .filter(isFinitePoint)
      .map((point) => transformPoint(point, geometry, config.coordinateGrid));
    const first = points[0];
    if (points.length === 1 && first) {
      paintCapsule(sampleMasks, first, first, config);
      continue;
    }
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (start && end) {
        paintCapsule(sampleMasks, start, end, config);
      }
    }
  }

  const samplesPerPixel = config.samplesPerAxis ** 2;
  const data = new Float32Array(sampleMasks.length);
  for (let index = 0; index < sampleMasks.length; index += 1) {
    data[index] = countSetBits(sampleMasks[index] ?? 0) / samplesPerPixel;
  }

  return {
    data,
    shape: [1, 1, config.height, config.width],
    width: config.width,
    height: config.height,
    geometry,
    preprocessingVersion: config.version,
  };
}

export function rgbaToNchw(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  if (rgba.length !== width * height * 4) {
    throw new RangeError("RGBA data does not match the supplied dimensions");
  }

  const data = new Float32Array(width * height);
  for (let index = 0; index < data.length; index += 1) {
    const rgbaIndex = index * 4;
    const luminance =
      (rgba[rgbaIndex] ?? 0) * 0.2126 +
      (rgba[rgbaIndex + 1] ?? 0) * 0.7152 +
      (rgba[rgbaIndex + 2] ?? 0) * 0.0722;
    data[index] = (luminance / 255) * ((rgba[rgbaIndex + 3] ?? 0) / 255);
  }
  return data;
}
