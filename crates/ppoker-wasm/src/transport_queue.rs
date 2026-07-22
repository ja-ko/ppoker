use std::collections::VecDeque;

use ppoker_core::client::TransportEvent;

// Retain at most 1,024 callback events and 1 MiB of UTF-8 text. A single
// terminal overflow marker is stored separately so accepted events drain first.
pub(crate) const MAX_QUEUED_EVENTS: usize = 1024;
pub(crate) const MAX_QUEUED_TEXT_BYTES: usize = 1024 * 1024;
pub(crate) const QUEUE_OVERFLOW_ERROR: &str = "Browser WebSocket event queue limit exceeded.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PushResult {
    Queued,
    Overflowed,
    Stopped,
}

#[derive(Default)]
pub(crate) struct EventQueue {
    events: VecDeque<TransportEvent>,
    queued_text_bytes: usize,
    overflow_error: Option<String>,
    stopped: bool,
}

impl EventQueue {
    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub(crate) fn push(&mut self, event: TransportEvent) -> PushResult {
        if self.stopped {
            return PushResult::Stopped;
        }

        let text_bytes = match &event {
            TransportEvent::Text(text) => text.len(),
            _ => 0,
        };
        let exceeds_text_budget = self
            .queued_text_bytes
            .checked_add(text_bytes)
            .is_none_or(|bytes| bytes > MAX_QUEUED_TEXT_BYTES);
        if self.events.len() >= MAX_QUEUED_EVENTS || exceeds_text_budget {
            return self.overflow();
        }

        let terminal = matches!(event, TransportEvent::Closed | TransportEvent::Error(_));
        self.queued_text_bytes += text_bytes;
        self.events.push_back(event);
        self.stopped = terminal;
        PushResult::Queued
    }

    pub(crate) fn overflow(&mut self) -> PushResult {
        if self.stopped {
            return PushResult::Stopped;
        }
        self.stopped = true;
        self.overflow_error = Some(QUEUE_OVERFLOW_ERROR.to_string());
        PushResult::Overflowed
    }

    pub(crate) fn pop(&mut self) -> Option<TransportEvent> {
        if let Some(event) = self.events.pop_front() {
            if let TransportEvent::Text(text) = &event {
                self.queued_text_bytes -= text.len();
            }
            Some(event)
        } else {
            self.overflow_error.take().map(TransportEvent::Error)
        }
    }

    pub(crate) fn clear(&mut self) {
        self.events.clear();
        self.queued_text_bytes = 0;
        self.overflow_error = None;
        self.stopped = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_budget_retains_prior_events_then_exactly_one_error() {
        let mut queue = EventQueue::default();
        assert!(!queue.is_stopped());
        assert!((0..MAX_QUEUED_EVENTS)
            .all(|length| { queue.push(TransportEvent::Binary { length }) == PushResult::Queued }));
        assert_eq!(
            queue.push(TransportEvent::Binary { length: usize::MAX }),
            PushResult::Overflowed
        );
        assert!(queue.is_stopped());
        assert_eq!(
            queue.push(TransportEvent::Error("late".to_string())),
            PushResult::Stopped
        );
        assert!((0..MAX_QUEUED_EVENTS)
            .all(|length| queue.pop() == Some(TransportEvent::Binary { length })));
        assert_eq!(
            queue.pop(),
            Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
        );
        assert_eq!(queue.pop(), None);
        queue.clear();
        assert!(queue.is_stopped());
    }

    #[test]
    fn text_budget_is_exact_and_decrements_as_messages_are_consumed() {
        let mut queue = EventQueue::default();
        for text in ["abc".to_string(), "x".repeat(MAX_QUEUED_TEXT_BYTES - 3)] {
            assert_eq!(queue.push(TransportEvent::Text(text)), PushResult::Queued);
        }
        assert_eq!(
            queue.push(TransportEvent::Text("overflow".to_string())),
            PushResult::Overflowed
        );
        for (text, remaining) in [
            ("abc".to_string(), MAX_QUEUED_TEXT_BYTES - 3),
            ("x".repeat(MAX_QUEUED_TEXT_BYTES - 3), 0),
        ] {
            assert_eq!(queue.pop(), Some(TransportEvent::Text(text)));
            assert_eq!(queue.queued_text_bytes, remaining);
        }
        assert_eq!(
            queue.pop(),
            Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
        );
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn oversized_first_text_stops_without_retaining_payload_or_late_events() {
        let mut queue = EventQueue::default();
        assert_eq!(
            queue.push(TransportEvent::Text("x".repeat(MAX_QUEUED_TEXT_BYTES + 1))),
            PushResult::Overflowed
        );
        assert_eq!(queue.queued_text_bytes, 0);
        assert_eq!(queue.push(TransportEvent::Opened), PushResult::Stopped);
        assert_eq!(
            queue.pop(),
            Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
        );
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn terminal_events_stop_late_callback_growth() {
        for terminal in [
            TransportEvent::Closed,
            TransportEvent::Error("failed".to_string()),
        ] {
            let mut queue = EventQueue::default();
            assert_eq!(queue.push(terminal), PushResult::Queued);
            assert_eq!(queue.overflow(), PushResult::Stopped);
            assert_eq!(
                queue.push(TransportEvent::Text("late".to_string())),
                PushResult::Stopped
            );
            assert!(queue.pop().is_some());
            assert_eq!(queue.pop(), None);
        }
    }
}
