export interface SectionLabelProps {
  readonly children: string;
}

export function SectionLabel({ children }: SectionLabelProps) {
  return (
    <div className="section-label type-label">
      <span aria-hidden="true" />
      {children}
    </div>
  );
}
