export interface MorphRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface InkMorphTransform {
  readonly originX: number;
  readonly originY: number;
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function fitRectToRect(
  source: MorphRect,
  target: MorphRect,
): InkMorphTransform | null {
  if (!isUsableRect(source) || !isUsableRect(target)) {
    return null;
  }

  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    return null;
  }

  return {
    originX: source.left,
    originY: source.top,
    translateX: target.left - source.left,
    translateY: target.top - source.top,
    scaleX,
    scaleY,
  };
}

function isUsableRect(rect: MorphRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}
