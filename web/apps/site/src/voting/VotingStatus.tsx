interface VotingStatusProps {
  readonly detail: string;
  readonly room?: string;
  readonly title: string;
  readonly role?: "alert" | "status";
}

export function VotingStatus({
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
        <span className="vote-status-pulse" aria-hidden="true" />
      </section>
    </main>
  );
}
