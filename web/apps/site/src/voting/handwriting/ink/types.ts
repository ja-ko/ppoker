export type InkPointerType = "mouse" | "pen" | "touch" | (string & {});

export interface InkPoint {
  x: number;
  y: number;
  time: number;
  pressure?: number;
  pointerType?: InkPointerType;
}

export interface InkStroke {
  points: InkPoint[];
}

export interface ImmutableInkStroke {
  readonly points: readonly Readonly<InkPoint>[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}
