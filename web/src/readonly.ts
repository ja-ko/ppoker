export type DeepReadonly<Value> = Value extends (
  ...arguments_: never[]
) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  freezeValue(value, new WeakSet<object>());
  return value as DeepReadonly<Value>;
}

function freezeValue(value: unknown, visited: WeakSet<object>): void {
  if (typeof value === "object" && value !== null) {
    if (visited.has(value)) {
      return;
    }
    visited.add(value);
    for (const nested of Object.values(value)) {
      freezeValue(nested, visited);
    }
    Object.freeze(value);
  }
}
