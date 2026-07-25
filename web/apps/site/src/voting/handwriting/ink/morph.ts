export interface MorphRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface InkMorphTransform {
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export function fitRectPreservingAspect(
  source: MorphRect,
  target: MorphRect,
): InkMorphTransform | null {
  if (!isUsableRect(source) || !isUsableRect(target)) {
    return null;
  }

  const scale = Math.min(
    target.width / source.width,
    target.height / source.height,
  );
  if (!Number.isFinite(scale)) {
    return null;
  }

  const targetLeft = target.left + (target.width - source.width * scale) / 2;
  const targetTop = target.top + (target.height - source.height * scale) / 2;

  return {
    originX: source.left,
    originY: source.top,
    scale,
    translateX: targetLeft - source.left,
    translateY: targetTop - source.top,
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
