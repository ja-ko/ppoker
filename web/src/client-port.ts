export interface PokerClientPort<Snapshot> {
  connect(): void;
  poll(): boolean;
  snapshot(): Snapshot;
  vote(value: string): void;
  retractVote(): void;
  rename(name: string): void;
  chat(message: string): void;
  reveal(): void;
  startNewRound(): void;
  close(): void;
}
