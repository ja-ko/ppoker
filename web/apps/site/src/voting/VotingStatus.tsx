interface VotingStatusProps {
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  readonly detail: string;
  readonly room?: string;
  readonly title: string;
  readonly role?: "alert" | "status";
}

export function VotingStatus({
  action,
  detail,
  room,
  role = "status",
  title,
}: VotingStatusProps) {
  return (
    <main className="vote-route vote-status-shell">
      <section
        className="vote-status-card"
        aria-atomic="true"
        aria-live={role === "alert" ? "assertive" : "polite"}
        role={role}
      >
        <div className="vote-brand" aria-hidden="true">
          <span>PP</span>
          <strong>Voter console</strong>
        </div>
        <p className="vote-kicker">
          {room ? `Room / ${room}` : "Planning poker"}
        </p>
        <h1>{title}</h1>
        <p>{detail}</p>
        {action === undefined ? null : (
          <button
            className="vote-status-action"
            onClick={action.onClick}
            type="button"
          >
            {action.label}
          </button>
        )}
        <span className="vote-status-pulse" aria-hidden="true" />
      </section>
    </main>
  );
}
